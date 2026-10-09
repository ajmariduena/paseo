import { useEffect, useState, useSyncExternalStore } from "react";
import { openHandoffForm } from "./form-model";
import type { HandoffOrigin } from "./persistence";
import { handoffFormPorts } from "./runtime";

export function useHandoffForm(origin: HandoffOrigin) {
  const [model] = useState(() => openHandoffForm(origin, handoffFormPorts));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    void model.load();
    return () => model.close();
  }, [model]);
  return { model, state };
}
