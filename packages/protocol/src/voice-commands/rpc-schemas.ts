import { z } from "zod";

/** A model on a provider that turns what the user says on a call into actions. */
export const VoiceCommandsModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

export const VoiceCommandsProviderSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    /** The key itself never leaves the host. */
    hasKey: z.boolean(),
    /** Only for the custom endpoint. */
    baseUrl: z.string().optional(),
  })
  .passthrough();

export const VoiceCommandsOptionSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

export const VoiceCommandsSettingsSchema = z
  .object({
    /** Null means calls hand every request to the agent. */
    selection: VoiceCommandsModelSchema.nullable(),
    backup: VoiceCommandsModelSchema.nullable(),
    /** What answers now: the selection, or the backup while the selection has no key. */
    active: VoiceCommandsModelSchema.nullable(),
    /** The last measured round trip of the active model, from a test or a real call. */
    lastRoundTripMs: z.number().nullable(),
    providers: z.array(VoiceCommandsProviderSchema),
    options: z.array(VoiceCommandsOptionSchema),
  })
  .passthrough();

export const VoiceCommandsGetSettingsRequestSchema = z.object({
  type: z.literal("voice.commands.get_settings.request"),
  requestId: z.string(),
});

export const VoiceCommandsGetSettingsResponseSchema = z.object({
  type: z.literal("voice.commands.get_settings.response"),
  payload: z.object({
    requestId: z.string(),
    settings: VoiceCommandsSettingsSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** Omitted fields stay as they are; null clears the selection or the backup. */
export const VoiceCommandsSetModelRequestSchema = z.object({
  type: z.literal("voice.commands.set_model.request"),
  selection: VoiceCommandsModelSchema.nullable().optional(),
  backup: VoiceCommandsModelSchema.nullable().optional(),
  /** Any OpenAI-compatible endpoint, used by the `custom` provider. */
  customBaseUrl: z.string().optional(),
  requestId: z.string(),
});

export const VoiceCommandsSetModelResponseSchema = z.object({
  type: z.literal("voice.commands.set_model.response"),
  payload: z.object({
    requestId: z.string(),
    settings: VoiceCommandsSettingsSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** A null key removes it. */
export const VoiceCommandsSetKeyRequestSchema = z.object({
  type: z.literal("voice.commands.set_key.request"),
  provider: z.string(),
  apiKey: z.string().nullable(),
  requestId: z.string(),
});

export const VoiceCommandsSetKeyResponseSchema = z.object({
  type: z.literal("voice.commands.set_key.response"),
  payload: z.object({
    requestId: z.string(),
    settings: VoiceCommandsSettingsSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** Sends one real routing request with the voice tools and measures the round trip. */
export const VoiceCommandsTestModelRequestSchema = z.object({
  type: z.literal("voice.commands.test_model.request"),
  target: z.enum(["selection", "backup"]),
  requestId: z.string(),
});

export const VoiceCommandsTestModelResponseSchema = z.object({
  type: z.literal("voice.commands.test_model.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    roundTripMs: z.number().nullable(),
    model: VoiceCommandsModelSchema.nullable(),
    error: z.string().nullable(),
    settings: VoiceCommandsSettingsSchema.nullable(),
  }),
});

export type VoiceCommandsModel = z.infer<typeof VoiceCommandsModelSchema>;
export type VoiceCommandsSettings = z.infer<typeof VoiceCommandsSettingsSchema>;
export type VoiceCommandsProvider = z.infer<typeof VoiceCommandsProviderSchema>;
export type VoiceCommandsOption = z.infer<typeof VoiceCommandsOptionSchema>;
