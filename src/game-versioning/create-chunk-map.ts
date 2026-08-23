import * as fs from "fs/promises";

import { createChunkMap, verifyChunkMap } from "./chunk-map";

async function main() {
    const [sourcePath, targetPath, outputPath] = process.argv.slice(2);
    if (sourcePath === undefined || targetPath === undefined || outputPath === undefined) {
        throw new Error("Usage: create-game-version-patch <source> <target> <output>");
    }
    await createChunkMap(sourcePath, targetPath, outputPath);
    await verifyChunkMap(sourcePath, targetPath, outputPath);
    const stat = await fs.stat(outputPath);
    console.log(`Verified ${outputPath} (${stat.size} bytes)`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
