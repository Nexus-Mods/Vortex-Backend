import { createPrivateKey, sign } from "crypto";
import * as fs from "fs/promises";

async function main() {
    const [catalogPath, outputPath] = process.argv.slice(2);
    const keyPath = process.env.GAME_VERSION_SIGNING_KEY_FILE;
    const keyId = process.env.GAME_VERSION_SIGNING_KEY_ID;
    if (catalogPath === undefined || outputPath === undefined || keyPath === undefined || keyId === undefined) {
        throw new Error(
            "Usage: GAME_VERSION_SIGNING_KEY_FILE=<pem> GAME_VERSION_SIGNING_KEY_ID=<id> " +
                "sign-game-version-catalog <catalog.json> <signed.json>",
        );
    }
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    const payload = Buffer.from(JSON.stringify(catalog), "utf8");
    const privateKey = createPrivateKey(await fs.readFile(keyPath, "utf8"));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
    const envelope = {
        schemaVersion: 1,
        keyId,
        payload: payload.toString("base64"),
        signature: sign(null, payload, privateKey).toString("base64"),
    };
    await fs.writeFile(outputPath, `${JSON.stringify(envelope, undefined, 2)}\n`, { flag: "wx" });
    console.log(`Signed ${catalogPath} as ${keyId}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
