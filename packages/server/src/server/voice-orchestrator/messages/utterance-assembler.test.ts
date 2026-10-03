import { describe, expect, it } from "vitest";
import { UtteranceAssembler } from "./utterance-assembler.js";

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}

describe("UtteranceAssembler", () => {
  it("joins chunks that arrive out of order and repeated", () => {
    const assembler = new UtteranceAssembler();
    const base = { utteranceId: "u1", chunkCount: 3, mimeType: "audio/mp4" };
    assembler.accept({ ...base, chunkIndex: 2, audio: b64("C") });
    assembler.accept({ ...base, chunkIndex: 0, audio: b64("A") });
    assembler.accept({ ...base, chunkIndex: 0, audio: b64("A") });
    const receipt = assembler.accept({ ...base, chunkIndex: 1, audio: b64("B") });

    expect(receipt).toMatchObject({ receivedChunks: 3, audioComplete: true, isNew: false });
    expect(assembler.finish("u1")?.audio?.data.toString()).toBe("ABC");
  });

  it("finishes with device text alone when the audio never completes", () => {
    const assembler = new UtteranceAssembler();
    assembler.accept({ utteranceId: "u1", text: " hola " });
    assembler.accept({
      utteranceId: "u1",
      chunkIndex: 0,
      chunkCount: 2,
      audio: b64("A"),
      mimeType: "audio/mp4",
    });

    expect(assembler.finish("u1")).toEqual({ utteranceId: "u1", deviceText: "hola", audio: null });
  });

  it("ignores parts for an utterance that already finished", () => {
    const assembler = new UtteranceAssembler();
    assembler.accept({ utteranceId: "u1", text: "hola" });
    assembler.finish("u1");

    expect(assembler.accept({ utteranceId: "u1", text: "otra vez" }).isNew).toBe(false);
    expect(assembler.finish("u1")).toBeNull();
  });

  it("prunes utterances that never completed", () => {
    const assembler = new UtteranceAssembler();
    assembler.accept({ utteranceId: "u1", chunkIndex: 0, chunkCount: 2, audio: b64("A") }, 0);
    assembler.prune(1_000, 5_000);

    expect(assembler.finish("u1")).toBeNull();
  });
});
