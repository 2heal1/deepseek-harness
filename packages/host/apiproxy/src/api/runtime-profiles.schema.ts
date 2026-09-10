/** Runtime Profile API request and response schemas. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  RuntimeProfileCatalogEntry,
  RuntimeProfileConfigView,
  RuntimeProfileDocumentView,
  RuntimeProfileProbeView,
  RuntimeRouteCatalogEntry,
  RuntimeSubagentRouteView,
} from './runtime-profiles.ts'

const identifierSchema = z.string().regex(/^[a-z][a-z0-9-]*$/)
const positiveIntegerSchema = z.number().int().positive()
const nonNegativeIntegerSchema = z.number().int().nonnegative()

/** Complete Runtime Profile input. */
export const runtimeProfileConfigSchema = z.object({
  provider: identifierSchema,
  schemaVersion: nonNegativeIntegerSchema.optional(),
  providerOptionsVersion: nonNegativeIntegerSchema.optional(),
  providerOptions: z.unknown().optional(),
  launch: z.object({
    executable: z.string().min(1).refine(value => !value.includes('\0')),
    args: z.array(z.string().refine(value => !value.includes('\0'))).optional(),
    resolution: z.union([
      z.literal('absolute'),
      z.object({ searchPath: z.array(z.string()) }),
    ]).optional(),
    cwdPolicy: z.union([
      z.literal('session-workspace'),
      z.literal('parent-workspace'),
      z.object({ fixed: z.string().min(1) }),
    ]),
    ambientEnv: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  model: z.object({
    default: z.string().optional(),
    allowSessionOverride: z.boolean().optional(),
  }).optional(),
  product: z.unknown().optional(),
  permissions: z.object({
    policy: z.unknown(),
    enforcement: z.union([z.literal('required'), z.literal('best-effort')]),
    approval: z.literal('unattended-fail-closed').optional(),
  }),
  nativeTools: z.object({ allowed: z.array(z.string()).optional() }).optional(),
  harnessTools: z.object({
    transport: z.union([z.literal('none'), z.literal('mcp')]).optional(),
    allowed: z.array(z.string()).optional(),
  }).optional(),
  credentials: z.object({
    env: z.record(z.string(), z.object({ credentialRef: z.string().min(1) })).optional(),
  }).optional(),
  process: z.object({
    startupTimeoutMs: positiveIntegerSchema,
    turnTimeoutMs: positiveIntegerSchema,
    shutdownTimeoutMs: positiveIntegerSchema,
    terminationTimeoutMs: positiveIntegerSchema,
    maxConcurrentRuns: positiveIntegerSchema,
  }),
}) satisfies z.ZodType<Wire<RuntimeProfileConfigView>>

/** One one-shot route input. */
export const runtimeSubagentRouteSchema = z.object({
  runtimeProfile: identifierSchema,
  mode: z.literal('one-shot').optional(),
  maxDepth: nonNegativeIntegerSchema,
  maxConcurrentRuns: positiveIntegerSchema,
  toolName: z.string().min(1),
}) satisfies z.ZodType<Wire<RuntimeSubagentRouteView>>

/** Safe profile catalog row. */
export const runtimeProfileCatalogEntrySchema = z.object({
  id: identifierSchema,
  provider: identifierSchema,
  model: z.string().optional(),
  isDefault: z.boolean(),
  providerAvailable: z.boolean(),
  schemaCompatible: z.boolean(),
}) satisfies z.ZodType<Wire<RuntimeProfileCatalogEntry>>

/** Safe route catalog row. */
export const runtimeRouteCatalogEntrySchema = z.object({
  id: identifierSchema,
  runtimeProfile: identifierSchema,
  toolName: z.string().min(1),
}) satisfies z.ZodType<Wire<RuntimeRouteCatalogEntry>>

/** Complete trusted editor response. */
export const runtimeProfileDocumentSchema = z.object({
  revision: nonNegativeIntegerSchema,
  writable: z.boolean(),
  defaultMainProfile: identifierSchema,
  profiles: z.record(identifierSchema, runtimeProfileConfigSchema),
  subagentRoutes: z.record(identifierSchema, runtimeSubagentRouteSchema),
  credentialStatus: z.record(
    identifierSchema,
    z.record(z.string(), z.boolean().nullable()),
  ),
}) satisfies z.ZodType<Wire<RuntimeProfileDocumentView>>

/** Provider capability descriptor. */
const runtimeCapabilitySchema = z.object({
  id: z.union([
    z.literal('continuation'),
    z.literal('steering'),
    z.literal('queuedInputRead'),
    z.literal('queuedInputMutation'),
    z.literal('injection'),
    z.literal('maintenance'),
    z.literal('imageInput'),
    z.literal('modelOverride'),
    z.literal('approvals'),
    z.literal('runtimeActivity'),
    z.literal('harnessTools'),
    z.literal('resume'),
    z.literal('coldResume'),
  ]),
  metadata: z.unknown().optional(),
})

/** Successful provider probe response. */
export const runtimeProfileProbeSchema = z.object({
  productVersion: z.string().optional(),
  protocolVersion: z.string().optional(),
  capabilities: z.array(runtimeCapabilitySchema),
  permissionEnforcement: z.union([
    z.literal('enforced'),
    z.literal('best-effort'),
    z.literal('unsupported'),
  ]),
  details: z.unknown().optional(),
}) satisfies z.ZodType<Wire<RuntimeProfileProbeView>>

/** Empty request for the safe Runtime Profile catalog. */
export const runtimeProfileCatalogRequestSchema = z.object(
  {},
) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.catalog'>>>

/** Safe Runtime Profile and route catalog response. */
export const runtimeProfileCatalogValueSchema = z.object({
  profiles: z.array(runtimeProfileCatalogEntrySchema),
  routes: z.array(runtimeRouteCatalogEntrySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.catalog'>>>

/** Empty request for the trusted Runtime Profile document. */
export const runtimeProfileDescribeRequestSchema = z.object(
  {},
) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.describe'>>>

/** Trusted Runtime Profile document response. */
export const runtimeProfileDescribeValueSchema =
  runtimeProfileDocumentSchema satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.describe'>>>

/** Revision-fenced Runtime Profile save request. */
export const runtimeProfileSaveRequestSchema = z.object({
  profileId: identifierSchema,
  profile: runtimeProfileConfigSchema,
  expectedRevision: nonNegativeIntegerSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.save'>>>

/** Runtime Profile document returned after a profile save. */
export const runtimeProfileSaveValueSchema =
  runtimeProfileDocumentSchema satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.save'>>>

/** Revision-fenced Runtime Profile removal request. */
export const runtimeProfileRemoveRequestSchema = z.object({
  profileId: identifierSchema,
  expectedRevision: nonNegativeIntegerSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.remove'>>>

/** Runtime Profile document returned after a profile removal. */
export const runtimeProfileRemoveValueSchema =
  runtimeProfileDocumentSchema satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.remove'>>>

/** Revision-fenced one-shot route save request. */
export const runtimeProfileSaveRouteRequestSchema = z.object({
  routeId: identifierSchema,
  route: runtimeSubagentRouteSchema,
  expectedRevision: nonNegativeIntegerSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.saveRoute'>>>

/** Runtime Profile document returned after a route save. */
export const runtimeProfileSaveRouteValueSchema =
  runtimeProfileDocumentSchema satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.saveRoute'>>>

/** Revision-fenced one-shot route removal request. */
export const runtimeProfileRemoveRouteRequestSchema = z.object({
  routeId: identifierSchema,
  expectedRevision: nonNegativeIntegerSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.removeRoute'>>>

/** Runtime Profile document returned after a route removal. */
export const runtimeProfileRemoveRouteValueSchema =
  runtimeProfileDocumentSchema satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.removeRoute'>>>

/** Revision-fenced default Runtime Profile update request. */
export const runtimeProfileSetDefaultRequestSchema = z.object({
  profileId: identifierSchema,
  expectedRevision: nonNegativeIntegerSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.setDefault'>>>

/** Runtime Profile document returned after a default update. */
export const runtimeProfileSetDefaultValueSchema =
  runtimeProfileDocumentSchema satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.setDefault'>>>

/** Request to probe one saved Runtime Profile. */
export const runtimeProfileProbeRequestSchema = z.object({
  profileId: identifierSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'runtimeProfile.probe'>>>

/** Provider facts returned by a successful Runtime Profile probe. */
export const runtimeProfileProbeValueSchema =
  runtimeProfileProbeSchema satisfies z.ZodType<Wire<ResponseValue<'runtimeProfile.probe'>>>
