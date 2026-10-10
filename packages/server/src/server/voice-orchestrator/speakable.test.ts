import { describe, expect, it } from "vitest";
import { speakableClip, toSpeakableText } from "./speakable.js";

describe("toSpeakableText", () => {
  it("keeps the report while stripping code, links and formatting", () => {
    expect(
      toSpeakableText(
        "## Resultado\n**Pruebas listas**. [Ver informe](https://example.test/report).\n```sh\nrm -rf secreto\n```\nFalta Bluetooth.",
      ),
    ).toBe("Resultado\nPruebas listas. Ver informe.\n(code)\nFalta Bluetooth.");
  });

  it("does not speak an unterminated code fence or its body", () => {
    expect(toSpeakableText("Terminó la revisión.\n```ts\nconst privateValue = 123;")).toBe(
      "Terminó la revisión.\n(code)",
    );
  });

  it("reduces paths to filenames and removes opaque identifiers", () => {
    expect(
      toSpeakableText(
        "Editó `/Users/alex/proyecto/src/login.ts` y packages/app/src/audio.ts.\nId: 12345678-1234-1234-1234-123456789abc\nCommit: abcdef123456abcdef.",
      ),
    ).toBe("Editó login.ts y audio.ts.\nId:\nCommit: .");
  });

  it("keeps short code identifiers, Spanish punctuation and measured numbers", () => {
    expect(
      toSpeakableText(
        "¿Cómo está? Usa 13,9 de 16 GB (87 %). `npm test` pasó; `snake_case` sigue igual.",
      ),
    ).toBe("¿Cómo está? Usa 13,9 de 16 GB (87 %). npm test pasó; snake_case sigue igual.");
  });

  it("normalizes a checklist without reading markdown markers or bare URLs", () => {
    expect(
      toSpeakableText(
        "- [x] Revisado\n- [ ] Bluetooth\nhttps://example.test/report\n> Sigue pendiente.",
      ),
    ).toBe("· Revisado\n· Bluetooth\n(link)\nSigue pendiente.");
  });
});

describe("speakableClip", () => {
  it("returns a short report unchanged and flattens its lines", () => {
    expect(speakableClip("Pruebas listas.\nFalta Bluetooth.", 80)).toBe(
      "Pruebas listas. Falta Bluetooth.",
    );
  });

  it("prefers a complete sentence near the length limit", () => {
    expect(speakableClip("Las pruebas terminaron bien. Falta revisar Bluetooth.", 35)).toBe(
      "Las pruebas terminaron bien.",
    );
  });

  it("cuts a long sentence at a word boundary", () => {
    expect(speakableClip("Revisando las pruebas de integración pendientes", 26)).toBe(
      "Revisando las pruebas de…",
    );
  });

  it("bounds text with no word boundaries", () => {
    expect(speakableClip("abcdefghijklmnopqrst", 8)).toBe("abcdefg…");
  });
});

describe("toSpeakableText images", () => {
  it("drops markdown images instead of leaving their alt text glued together", () => {
    expect(
      toSpeakableText("![Image](https://x.test/a.png)![Image](https://x.test/b.png) Listo."),
    ).toBe("Listo.");
  });
});
