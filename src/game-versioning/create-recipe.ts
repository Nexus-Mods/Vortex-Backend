import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { pipeline } from "stream/promises";

import { createAndVerifyBinaryPatch } from "./binary-patch";
import { createChunkMap, verifyChunkMap } from "./chunk-map";

interface IJob {
    gameId: string;
    appId: string;
    executable: string;
    sourceVersion: string;
    versions: Record<string, string[]>;
    outputPath: string;
}

interface IFileEntry {
    path: string;
    absolutePath: string;
    size: number;
    sha256?: string;
}

const SKYRIM_FILES = [
    { sourcePath: "SkyrimSE.exe", targetPath: "SkyrimSE.exe" },
    { sourcePath: "SkyrimSELauncher.exe", targetPath: "SkyrimSELauncher.exe" },
    { sourcePath: "steam_api64.dll", targetPath: "steam_api64.dll" },
    { sourcePath: "Data/Skyrim - Shaders.bsa", targetPath: "Data/Skyrim - Shaders.bsa" },
    { sourcePath: "bink2w64.dll", targetPath: "binkw64.dll" },
];
const FALLOUT_FILES = [
    { sourcePath: "Fallout4.exe", targetPath: "Fallout4.exe" },
    { sourcePath: "Fallout4Launcher.exe", targetPath: "Fallout4Launcher.exe" },
    { sourcePath: "steam_api64.dll", targetPath: "steam_api64.dll" },
];
const artifactCache = new Map<
    string,
    { algorithm: "bsdiff40-v1" | "chunk-map-v1"; sha256: string; size: number }
>();

function compatibilityNote(gameId: string, version: string): string | undefined {
    if (gameId === "skyrimse" && /^1\.5\.97(?:\.0)?$/.test(version)) {
        return "This runtime keeps the current game archives. Collections targeting Skyrim 1.5.97 should include Backported Extended ESL Support (BEES).";
    }
    if (gameId === "fallout4" && /^1\.10\.163(?:\.0)?$/.test(version)) {
        return "This runtime keeps the current game archives. Collections targeting Fallout 4 1.10.163 should include Backported Archive2 Support System (BASS).";
    }
    return undefined;
}

async function collectFiles(roots: string[]): Promise<Map<string, IFileEntry>> {
    const result = new Map<string, IFileEntry>();
    const visit = async (root: string, directory: string) => {
        for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
            const absolutePath = path.join(directory, item.name);
            if (item.isSymbolicLink()) throw new Error(`Depot contains a symbolic link: ${absolutePath}`);
            if (item.isDirectory()) {
                await visit(root, absolutePath);
            } else if (item.isFile()) {
                const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
                result.set(relativePath.toLowerCase(), {
                    path: relativePath,
                    absolutePath,
                    size: (await fsp.stat(absolutePath)).size,
                });
            }
        }
    };
    for (const root of roots) await visit(root, root);
    return result;
}

async function hashFile(file: IFileEntry): Promise<string> {
    if (file.sha256 === undefined) {
        const hash = createHash("sha256");
        await pipeline(fs.createReadStream(file.absolutePath), hash);
        file.sha256 = hash.digest("hex");
    }
    return file.sha256;
}

function closestSource(target: IFileEntry, source: Map<string, IFileEntry>): IFileEntry | undefined {
    const extension = path.extname(target.path).toLowerCase();
    return [...source.values()]
        .filter((candidate) => path.extname(candidate.path).toLowerCase() === extension)
        .sort((left, right) => Math.abs(left.size - target.size) - Math.abs(right.size - target.size))[0];
}

async function artifact(
    source: IFileEntry,
    target: IFileEntry,
    artifactRoot: string,
    cacheKey: string,
): Promise<{ algorithm: "bsdiff40-v1" | "chunk-map-v1"; sha256: string; size: number }> {
    const cached = artifactCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const temporary = path.join(artifactRoot, `.partial-${randomUUID()}`);
    const algorithm: "bsdiff40-v1" | "chunk-map-v1" =
        Math.max(source.size, target.size) <= 256 * 1024 * 1024 ? "bsdiff40-v1" : "chunk-map-v1";
    if (algorithm === "bsdiff40-v1") {
        await createAndVerifyBinaryPatch(source.absolutePath, target.absolutePath, temporary);
    } else {
        await createChunkMap(source.absolutePath, target.absolutePath, temporary);
        await verifyChunkMap(source.absolutePath, target.absolutePath, temporary);
    }
    const entry: IFileEntry = {
        path: path.basename(temporary),
        absolutePath: temporary,
        size: (await fsp.stat(temporary)).size,
    };
    const sha256 = await hashFile(entry);
    const finalPath = path.join(artifactRoot, sha256);
    try {
        await fsp.rename(temporary, finalPath);
    } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        await fsp.rm(temporary, { force: true });
    }
    const result = { algorithm, sha256, size: entry.size };
    artifactCache.set(cacheKey, result);
    return result;
}

function candidatePairs(
    gameId: string,
    target: Map<string, IFileEntry>,
) {
    if (gameId === "skyrimse") return SKYRIM_FILES;
    if (gameId === "fallout4") return FALLOUT_FILES;
    return [...target.values()].map((file) => ({ sourcePath: file.path, targetPath: file.path }));
}

async function main() {
    const jobPath = process.argv[2];
    if (jobPath === undefined) throw new Error("Usage: create-game-version-recipe <job.json>");
    const job = JSON.parse(await fsp.readFile(jobPath, "utf8")) as IJob;
    if (job.versions[job.sourceVersion] === undefined) throw new Error("Source version is missing");
    await fsp.mkdir(job.outputPath, { recursive: true });
    const artifactRoot = path.join(job.outputPath, "artifacts", "sha256");
    const inventoryRoot = path.join(job.outputPath, "inventories");
    await Promise.all([
        fsp.mkdir(artifactRoot, { recursive: true }),
        fsp.mkdir(inventoryRoot, { recursive: true }),
    ]);

    const files = new Map<string, Map<string, IFileEntry>>();
    for (const [version, roots] of Object.entries(job.versions)) {
        const entries = await collectFiles(roots);
        files.set(version, entries);
        const relevant =
            job.gameId === "skyrimse" || job.gameId === "fallout4"
                ? [
                      ...new Set(
                          (job.gameId === "skyrimse" ? SKYRIM_FILES : FALLOUT_FILES).flatMap(
                              (item) => [item.sourcePath, item.targetPath],
                          ),
                      ),
                  ]
                      .map((item) => entries.get(item.toLowerCase()))
                      .filter((item): item is IFileEntry => item !== undefined)
                : [...entries.values()];
        const inventory = [];
        for (const file of relevant.sort((left, right) => left.path.localeCompare(right.path))) {
            inventory.push({ path: file.path, size: file.size, sha256: await hashFile(file) });
        }
        await fsp.writeFile(
            path.join(inventoryRoot, `${version.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`),
            `${JSON.stringify(inventory, undefined, 2)}\n`,
        );
    }

    const sourceFiles = files.get(job.sourceVersion)!;
    const sourceExecutable = sourceFiles.get(job.executable.toLowerCase());
    if (sourceExecutable === undefined) throw new Error(`Source executable is missing: ${job.executable}`);
    const targets = [];
    for (const [version, targetFiles] of files) {
        if (version === job.sourceVersion) continue;
        const operations: any[] = [];
        const targetFingerprint: any[] = [];
        for (const pair of candidatePairs(job.gameId, targetFiles)) {
            let donorFiles = targetFiles;
            if (job.gameId === "skyrimse" && /^1\.5\.97(?:\.0)?$/.test(version)) {
                if (pair.targetPath === "SkyrimSELauncher.exe") {
                    const donor = [...files].find(([candidate]) => /^1\.6\.640(?:\.0)?$/.test(candidate));
                    if (donor === undefined) {
                        throw new Error("Skyrim 1.5.97 requires the selected 1.6.640 launcher donor");
                    }
                    donorFiles = donor[1];
                } else if (pair.targetPath === "Data/Skyrim - Shaders.bsa") {
                    const donor = [...files].find(([candidate]) => /^1\.6\.1170(?:\.0)?$/.test(candidate));
                    if (donor === undefined) {
                        throw new Error("Skyrim 1.5.97 requires the selected 1.6.1170 shader donor");
                    }
                    donorFiles = donor[1];
                }
            }
            const target = donorFiles.get(pair.targetPath.toLowerCase());
            if (target === undefined) continue;
            let source = sourceFiles.get(pair.sourcePath.toLowerCase());
            if (source === undefined) source = closestSource(target, sourceFiles);
            if (source === undefined) throw new Error(`No delta source found for ${target.path}`);
            const [sourceSha256, targetSha256] = await Promise.all([hashFile(source), hashFile(target)]);
            targetFingerprint.push({ path: target.path, size: target.size, sha256: targetSha256 });
            if (sourceSha256 === targetSha256 && source.path.toLowerCase() === target.path.toLowerCase()) {
                continue;
            }
            const patch = await artifact(
                source,
                target,
                artifactRoot,
                `${sourceSha256}:${targetSha256}`,
            );
            operations.push({
                type: "patch",
                algorithm: patch.algorithm,
                sourcePath: source.path,
                targetPath: target.path,
                sourceSha256,
                targetSha256,
                targetSize: target.size,
                artifact: {
                    url: `https://REPLACE_WITH_ARTIFACT_HOST/${patch.sha256}`,
                    sha256: patch.sha256,
                    size: patch.size,
                },
            });
            if (
                source.path.toLowerCase() !== target.path.toLowerCase() &&
                !targetFiles.has(source.path.toLowerCase())
            ) {
                operations.push({ type: "remove", targetPath: source.path });
            }
        }
        if (job.gameId !== "skyrimse" && job.gameId !== "fallout4") {
            const removed = new Set(
                operations
                    .filter((operation) => operation.type === "remove")
                    .map((operation) => operation.targetPath.toLowerCase()),
            );
            for (const source of sourceFiles.values()) {
                if (
                    !targetFiles.has(source.path.toLowerCase()) &&
                    !removed.has(source.path.toLowerCase())
                ) {
                    operations.push({ type: "remove", targetPath: source.path });
                }
            }
        }
        const targetExecutable = targetFiles.get(job.executable.toLowerCase());
        if (targetExecutable === undefined) throw new Error(`Target executable is missing: ${job.executable}`);
        if (!targetFingerprint.some((entry) => entry.path.toLowerCase() === job.executable.toLowerCase())) {
            targetFingerprint.push({
                path: targetExecutable.path,
                size: targetExecutable.size,
                sha256: await hashFile(targetExecutable),
            });
        }
        const note = compatibilityNote(job.gameId, version);
        targets.push({
            version,
            aliases: [version.replace(/\.0$/, "")],
            ...(note === undefined ? {} : { compatibilityNote: note }),
            fingerprint: { files: targetFingerprint },
            transitions: [
                {
                    source: {
                        files: [
                            {
                                path: sourceExecutable.path,
                                size: sourceExecutable.size,
                                sha256: await hashFile(sourceExecutable),
                            },
                        ],
                    },
                    operations,
                },
            ],
        });
    }
    const catalog = {
        schemaVersion: 1,
        providerId: "bethesda-v1",
        games: [{ gameId: job.gameId, store: "steam", appId: job.appId, targets }],
    };
    await fsp.writeFile(path.join(job.outputPath, "catalog-draft.json"), `${JSON.stringify(catalog, undefined, 2)}\n`);
    console.log(`Created ${targets.length} verified transition recipe(s) in ${job.outputPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
