import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { once } from "events";
import { pipeline } from "stream/promises";
import { createGunzip, createGzip } from "zlib";

const MAGIC = Buffer.from("VGCMP1\0", "ascii");
const MIN_CHUNK = 64 * 1024;
const MAX_CHUNK = 1024 * 1024;
const AVERAGE_MASK = 256 * 1024 - 1;
const MAX_COPY = 64 * 1024 * 1024;
const MAX_LITERAL = 16 * 1024 * 1024;

interface IChunk {
    offset: number;
    data: Buffer;
}

interface ICopy {
    type: "copy";
    offset: number;
    length: number;
}

interface ILiteral {
    type: "literal";
    parts: Buffer[];
    length: number;
}

type PendingInstruction = ICopy | ILiteral;

function gearTable(): number[] {
    let value = 0x9e3779b9;
    return Array.from({ length: 256 }, () => {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        return value >>> 0;
    });
}

const GEAR = gearTable();

async function* chunks(filePath: string): AsyncGenerator<IChunk> {
    let fileOffset = 0;
    let chunkOffset = 0;
    let chunkLength = 0;
    let rolling = 0;
    let parts: Buffer[] = [];
    for await (const input of fs.createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 })) {
        const buffer = input as Buffer;
        let partStart = 0;
        for (let index = 0; index < buffer.length; index++) {
            rolling = ((rolling << 1) + GEAR[buffer[index]]) >>> 0;
            chunkLength++;
            const boundary =
                chunkLength >= MAX_CHUNK ||
                (chunkLength >= MIN_CHUNK && (rolling & AVERAGE_MASK) === 0);
            if (boundary) {
                parts.push(buffer.subarray(partStart, index + 1));
                yield { offset: chunkOffset, data: Buffer.concat(parts, chunkLength) };
                chunkOffset += chunkLength;
                chunkLength = 0;
                rolling = 0;
                parts = [];
                partStart = index + 1;
            }
        }
        if (partStart < buffer.length) {
            parts.push(buffer.subarray(partStart));
        }
        fileOffset += buffer.length;
    }
    if (chunkLength > 0) {
        yield { offset: chunkOffset, data: Buffer.concat(parts, chunkLength) };
    }
    if (chunkOffset + chunkLength !== fileOffset) {
        throw new Error("Chunking did not consume the complete input");
    }
}

function chunkKey(data: Buffer): string {
    return `${data.length}:${createHash("sha256").update(data).digest("hex")}`;
}

async function write(stream: NodeJS.WritableStream, data: Buffer): Promise<void> {
    if (!stream.write(data)) {
        await once(stream, "drain");
    }
}

async function writeInstruction(stream: NodeJS.WritableStream, instruction: PendingInstruction) {
    if (instruction.type === "copy") {
        const header = Buffer.alloc(13);
        header[0] = 0x00;
        header.writeUInt32LE(instruction.offset % 0x100000000, 1);
        header.writeUInt32LE(Math.floor(instruction.offset / 0x100000000), 5);
        header.writeUInt32LE(instruction.length, 9);
        await write(stream, header);
    } else {
        const header = Buffer.alloc(5);
        header[0] = 0x01;
        header.writeUInt32LE(instruction.length, 1);
        await write(stream, header);
        for (const part of instruction.parts) {
            await write(stream, part);
        }
    }
}

/** Creates a content-defined, gzip-compressed map of source ranges and target literals. */
export async function createChunkMap(sourcePath: string, targetPath: string, outputPath: string) {
    const sourceChunks = new Map<string, { offset: number; length: number }>();
    for await (const chunk of chunks(sourcePath)) {
        const key = chunkKey(chunk.data);
        if (!sourceChunks.has(key)) {
            sourceChunks.set(key, { offset: chunk.offset, length: chunk.data.length });
        }
    }

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    const gzip = createGzip({ level: 9 });
    const destination = fs.createWriteStream(outputPath, { flags: "wx" });
    const completed = pipeline(gzip, destination);
    let pending: PendingInstruction | undefined;
    const flush = async () => {
        if (pending !== undefined) {
            await writeInstruction(gzip, pending);
            pending = undefined;
        }
    };
    try {
        await write(gzip, MAGIC);
        for await (const chunk of chunks(targetPath)) {
            const match = sourceChunks.get(chunkKey(chunk.data));
            if (match !== undefined) {
                if (
                    pending?.type === "copy" &&
                    pending.offset + pending.length === match.offset &&
                    pending.length + match.length <= MAX_COPY
                ) {
                    pending.length += match.length;
                } else {
                    await flush();
                    pending = { type: "copy", offset: match.offset, length: match.length };
                }
            } else if (
                pending?.type === "literal" &&
                pending.length + chunk.data.length <= MAX_LITERAL
            ) {
                pending.parts.push(chunk.data);
                pending.length += chunk.data.length;
            } else {
                await flush();
                pending = { type: "literal", parts: [chunk.data], length: chunk.data.length };
            }
        }
        await flush();
        await write(gzip, Buffer.from([0xff]));
        gzip.end();
        await completed;
    } catch (err) {
        gzip.destroy();
        destination.destroy();
        await fsp.rm(outputPath, { force: true });
        throw err;
    }
}

async function hashFile(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
}

/** Uses Vortex's chunk-map reader contract to verify a generated artifact. */
export async function verifyChunkMap(sourcePath: string, targetPath: string, patchPath: string) {
    const verificationPath = `${patchPath}.verify-${randomUUID()}`;
    const source = await fsp.open(sourcePath, "r");
    const output = await fsp.open(verificationPath, "wx");
    const input = fs.createReadStream(patchPath).pipe(createGunzip());
    let buffered = Buffer.alloc(0);
    let position = 0;
    const read = async (length: number): Promise<Buffer> => {
        while (buffered.length < length) {
            const next = input.read() as Buffer | null;
            if (next === null) {
                if ((input as any).readableEnded) throw new Error("Unexpected end of chunk-map");
                await once(input, "readable");
            } else {
                buffered = buffered.length === 0 ? next : Buffer.concat([buffered, next]);
            }
        }
        const result = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        return result;
    };
    try {
        if (!(await read(MAGIC.length)).equals(MAGIC)) throw new Error("Invalid chunk-map header");
        while (true) {
            const opcode = (await read(1))[0];
            if (opcode === 0xff) break;
            if (opcode === 0x00) {
                const header = await read(12);
                const offset = header.readUInt32LE(0) + header.readUInt32LE(4) * 0x100000000;
                const length = header.readUInt32LE(8);
                const data = Buffer.allocUnsafe(length);
                const result = await source.read(data, 0, length, offset);
                if (result.bytesRead !== length) throw new Error("Copy exceeds source file");
                await output.write(data, 0, length, position);
                position += length;
            } else if (opcode === 0x01) {
                const length = (await read(4)).readUInt32LE(0);
                const data = await read(length);
                await output.write(data, 0, length, position);
                position += length;
            } else {
                throw new Error(`Unknown chunk-map opcode: ${opcode}`);
            }
        }
        await Promise.all([source.close(), output.close()]);
        const [expected, actual] = await Promise.all([hashFile(targetPath), hashFile(verificationPath)]);
        if (expected !== actual) throw new Error("Reconstructed file does not match its target");
    } finally {
        await source.close().catch(() => undefined);
        await output.close().catch(() => undefined);
        input.destroy();
        await fsp.rm(verificationPath, { force: true });
    }
}
