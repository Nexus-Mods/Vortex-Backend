import { createHash } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { pipeline } from "stream/promises";

async function hashFile(filePath: string) {
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
}

async function main() {
    const [outputRoot, artifactBaseUrl, ...draftPaths] = process.argv.slice(2);
    if (outputRoot === undefined || artifactBaseUrl === undefined || draftPaths.length === 0) {
        throw new Error(
            "Usage: assemble-game-version-catalog <output-dir> <artifact-base-url> <catalog-draft...>",
        );
    }
    const games = new Map<string, any>();
    const artifactOutput = path.join(outputRoot, "artifacts", "sha256");
    await fsp.mkdir(artifactOutput, { recursive: true });
    for (const draftPath of draftPaths) {
        const draft = JSON.parse(await fsp.readFile(draftPath, "utf8"));
        if (draft.schemaVersion !== 1 || draft.providerId !== "bethesda-v1") {
            throw new Error(`Invalid catalog draft: ${draftPath}`);
        }
        for (const game of draft.games) {
            const key = `${game.gameId}:${game.store}`;
            const existing = games.get(key);
            if (existing === undefined) games.set(key, game);
            else existing.targets.push(...game.targets);
            for (const target of game.targets) {
                for (const transition of target.transitions) {
                    for (const operation of transition.operations) {
                        if (operation.type === "patch") {
                            operation.artifact.url = `${artifactBaseUrl.replace(/\/$/, "")}/${operation.artifact.sha256}`;
                        }
                    }
                }
            }
        }
        const artifactInput = path.join(path.dirname(draftPath), "artifacts", "sha256");
        for (const artifact of await fsp.readdir(artifactInput, { withFileTypes: true })) {
            if (!artifact.isFile() || !/^[a-f0-9]{64}$/.test(artifact.name)) continue;
            const source = path.join(artifactInput, artifact.name);
            const destination = path.join(artifactOutput, artifact.name);
            const sourceHash = await hashFile(source);
            if (sourceHash !== artifact.name) throw new Error(`Invalid artifact: ${artifact.name}`);
            try {
                await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
            } catch (err: any) {
                if (err.code !== "EEXIST") throw err;
                const destinationHash = await hashFile(destination);
                if (destinationHash !== artifact.name) {
                    throw new Error(`Artifact collision: ${artifact.name}`);
                }
            }
        }
    }
    const catalog = {
        schemaVersion: 1,
        providerId: "bethesda-v1",
        games: [...games.values()],
    };
    await fsp.writeFile(
        path.join(outputRoot, "catalog.json"),
        `${JSON.stringify(catalog, undefined, 2)}\n`,
        { flag: "wx" },
    );
    console.log(`Assembled ${games.size} games in ${outputRoot}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
