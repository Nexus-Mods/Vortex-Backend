import * as fs from "fs/promises";
import * as path from "path";

interface IWasmExports {
    memory: WebAssembly.Memory;
    alloc(size: number): number;
    dealloc(pointer: number, size: number): void;
    create_patch(basePointer: number, baseLength: number, nextPointer: number, nextLength: number): number;
    apply_patch(basePointer: number, baseLength: number, patchPointer: number, patchLength: number): number;
    output_ptr(): number;
    output_len(): number;
    free_output(): void;
}

let wasm: IWasmExports | undefined;

async function instance(): Promise<IWasmExports> {
    if (wasm === undefined) {
        const entry = require.resolve("@hot-updater/bsdiff");
        const bytes = await fs.readFile(path.resolve(entry, "..", "..", "assets", "hdiff.wasm"));
        const module = new WebAssembly.Module(bytes);
        wasm = new WebAssembly.Instance(module).exports as unknown as IWasmExports;
    }
    return wasm;
}

async function run(name: "create_patch" | "apply_patch", left: Buffer, right: Buffer) {
    const api = await instance();
    const leftPointer = api.alloc(left.length);
    const rightPointer = api.alloc(right.length);
    try {
        new Uint8Array(api.memory.buffer, leftPointer, left.length).set(left);
        new Uint8Array(api.memory.buffer, rightPointer, right.length).set(right);
        const status = api[name](leftPointer, left.length, rightPointer, right.length);
        if (status !== 0) throw new Error(`bsdiff ${name} failed with status ${status}`);
        const result = Buffer.from(
            new Uint8Array(api.memory.buffer, api.output_ptr(), api.output_len()),
        );
        api.free_output();
        return result;
    } finally {
        if (left.length > 0) api.dealloc(leftPointer, left.length);
        if (right.length > 0) api.dealloc(rightPointer, right.length);
    }
}

export async function createAndVerifyBinaryPatch(
    sourcePath: string,
    targetPath: string,
    patchPath: string,
) {
    const [source, target] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]);
    const patch = await run("create_patch", source, target);
    const reconstructed = await run("apply_patch", source, patch);
    if (!reconstructed.equals(target)) {
        throw new Error(`Failed to reconstruct ${targetPath}`);
    }
    await fs.writeFile(patchPath, patch, { flag: "wx" });
}
