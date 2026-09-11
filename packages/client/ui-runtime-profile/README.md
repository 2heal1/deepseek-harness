# @deepseek-ai/dsh-client-ui-runtime-profile

English | [中文](README.zh.md)

Browser Runtime Profile surfaces over the Host's split read contracts. Every client receives the safe `runtimeProfile.catalog` projection for new-session selection and pinned-profile labels. Only a loopback client registers the Settings section that reads the complete non-secret document, edits profiles and one-shot subagent routes, and probes a Provider.

## Session selection

The conversation hero selector lists each profile's id, Provider, optional model, availability, and snapshot-schema compatibility. Unavailable or incompatible rows remain visible but cannot be selected. Selecting a row creates a new Session with an explicit `runtimeProfile` and opens it; it never changes the runtime of an existing Session. The conversation header reads the profile id fixed in that Session's Header, so later profile edits do not relabel historical sessions.

## Trusted editor

The loopback-only Settings section edits executable resolution, arguments, working-directory policy, model policy, permissions, tool allowlists, environment literals, credential references, Provider-owned JSON, process deadlines, capacity, and one-shot routes. Credential values never enter client state; the editor receives only configured, missing, or unavailable-service status for each reference.

Every write carries the last loaded Settings revision. A conflict or complete-document validation failure leaves the draft visible and reports the Host error. Remove operations delete the user-layer entry: an entry supplied by the composition base becomes visible again, while a user-created entry disappears. A read-only Settings provider disables all mutations.

Provider probes run independently of Session creation and report product/protocol versions, capabilities, permission enforcement, and safe Provider details. Provider absence and snapshot-schema incompatibility disable selection before probing; the Host remains the authority for every create and probe request.

The `/client` export includes `apply`, `RuntimeProfileController`, the three slot components, their injected faces, and the shared `RuntimeProfileState`.

## Model Experience

Indirectly, through the explicit `runtimeProfile` passed to `session.create`; the pinned Runtime Profile selects the downstream Provider, model policy, and tool policy, while this browser package contributes no model request text.

#### KV Cache effect

Selecting another profile creates a different Session and may choose a different downstream request prefix or Provider cache; the browser UI itself does not assemble requests.

## Known Limitations and Deferred Work

- **No in-place runtime switch** - choosing a profile always creates a new Session because a published Session already owns an immutable Runtime Profile snapshot.
- **No remote editor** - non-loopback clients receive safe catalog fields only; full configuration, credential-reference status, writes, and probes require a future authenticated administrative control plane.
- **Base ownership is not identified** - the editor cannot distinguish a composition-base row from a user-created row before removal; after removal, the Host's effective document reveals whether a base row remains.
