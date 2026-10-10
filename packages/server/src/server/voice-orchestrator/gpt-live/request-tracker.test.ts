import { describe, expect, it } from "vitest";
import { RequestTracker } from "./request-tracker.js";

describe("RequestTracker", () => {
  it("keeps the request prefix across a brief assistant backchannel", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    tracker.noteUser("¿Cómo va el ", 1_000);
    tracker.noteAssistant("Te escucho.", 1_100);
    tracker.noteUser("upgrade de Paseo?", 1_300);

    expect(tracker.peek()).toBe("¿Cómo va el upgrade de Paseo?");
    expect(tracker.take()).toBe("¿Cómo va el upgrade de Paseo?");
    expect(tracker.peek()).toBe("");
    expect(tracker.take()).toBe("");
  });

  it("starts the next request after a full assistant reply of four words", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    tracker.noteUser("¿Cómo va Upstream?", 1_000);
    tracker.noteAssistant("Ya terminó las ", 1_200);
    tracker.noteAssistant("pruebas.", 1_300);
    tracker.noteUser("¿Y la sesión Voz?", 2_000);

    expect(tracker.take()).toBe("¿Y la sesión Voz?");
  });

  it("does not mistake three assistant words for a full reply", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    tracker.noteUser("Crea un workspace ", 1_000);
    tracker.noteAssistant("Sí, te escucho.", 1_100);
    tracker.noteUser("en el Mini.", 1_500);

    expect(tracker.take()).toBe("Crea un workspace en el Mini.");
  });

  it("does not lose the user request when the assistant speaks after it", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    tracker.noteUser("Revisa el login de Paseo.", 1_000);
    tracker.noteAssistant("Voy a revisar ese fallo ahora.", 1_500);

    expect(tracker.take()).toBe("Revisa el login de Paseo.");
  });

  it("keeps a real spoken yes on direct WebRTC", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    tracker.noteAssistant("Para autorizar el push, di sí.", 1_000);
    tracker.noteUser("sí", 2_000);

    expect(tracker.take()).toBe("sí");
  });

  it("filters relayed echo while retaining a later distinct request", () => {
    const tracker = new RequestTracker({ filterEcho: true });
    tracker.noteAssistant("Ya terminaron todas las pruebas.", 1_000);
    tracker.noteUser("Ya terminaron todas las pruebas.", 1_100);
    tracker.noteUser("¿Qué falta revisar?", 2_100);

    expect(tracker.take()).toBe("¿Qué falta revisar?");
  });

  it("normalizes fragment whitespace without replaying consumed requests", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    tracker.noteUser("  Crea ", 1_000);
    tracker.noteUser("un\nworkspace. ", 1_200);
    expect(tracker.take()).toBe("Crea un workspace.");
    tracker.noteUser("Ahora una nota.", 3_000);

    expect(tracker.take()).toBe("Ahora una nota.");
  });

  it("keeps the consumption boundary when the transcript buffer rolls over", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    for (let i = 0; i < 400; i += 1) tracker.noteUser("antiguo ", i);
    tracker.take();
    tracker.noteUser("Lo nuevo.", 500);

    expect(tracker.take()).toBe("Lo nuevo.");
    expect(tracker.take()).toBe("");
  });

  it("counts assistant words across transcript deltas, not once per partial token", () => {
    const tracker = new RequestTracker({ filterEcho: false });
    tracker.noteUser("Crea un workspace ", 1_000);
    tracker.noteAssistant("De a", 1_100);
    tracker.noteAssistant("cuer", 1_120);
    tracker.noteAssistant("do.", 1_140);
    tracker.noteUser("en el Mini.", 1_500);

    expect(tracker.take()).toBe("Crea un workspace en el Mini.");
  });
});
