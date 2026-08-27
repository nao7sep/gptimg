import { describe, expect, it } from "vitest";
import * as ort from "onnxruntime-node";

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

function bytesField(field: number, value: Uint8Array): Uint8Array {
  return concat(varint((field << 3) | 2), varint(value.byteLength), value);
}

function intField(field: number, value: number): Uint8Array {
  return concat(varint(field << 3), varint(value));
}

function stringField(field: number, value: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(value));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function tensorValueInfo(name: string): Uint8Array {
  const dimension = intField(1, 1);
  const shape = bytesField(1, dimension);
  const tensorType = concat(intField(1, 1), bytesField(2, shape)); // FLOAT[1]
  const type = bytesField(1, tensorType);
  return concat(stringField(1, name), bytesField(2, type));
}

/** Minimal ONNX Identity graph, encoded directly so the native smoke test owns no model fixture. */
function identityModel(): Uint8Array {
  const node = concat(stringField(1, "input"), stringField(2, "output"), stringField(4, "Identity"));
  const graph = concat(
    bytesField(1, node),
    stringField(2, "gptimg-native-smoke"),
    bytesField(11, tensorValueInfo("input")),
    bytesField(12, tensorValueInfo("output")),
  );
  const opset = intField(2, 13);
  return concat(intField(1, 8), bytesField(7, graph), bytesField(8, opset));
}

describe("native ONNX Runtime compatibility", () => {
  it("creates a CPU session and executes a real graph", async () => {
    const session = await ort.InferenceSession.create(identityModel(), {
      executionProviders: ["cpu"],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
    try {
      const output = await session.run({
        input: new ort.Tensor("float32", Float32Array.from([42]), [1]),
      });

      expect(session.inputNames).toEqual(["input"]);
      expect(session.outputNames).toEqual(["output"]);
      const outputTensor = output.output;
      expect(outputTensor).toBeDefined();
      expect(outputTensor?.data).toBeInstanceOf(Float32Array);
      expect(Array.from(outputTensor?.data as Float32Array)).toEqual([42]);
    } finally {
      await session.release();
    }
  });
});
