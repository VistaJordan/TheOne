# Quotato — Integration Map

Reverse-engineered from `Quo X Quote Builder/` (read-only). Next.js 15 App Router + Prisma 6 + Postgres/Neon on Vercel. Package name `quotato` (`package.json:2`).

**Verdict up front:** the README's "connection-only" claim is **stale**. The repo is the comms layer *and* a working RAG quote drafter (Qdrant + OpenRouter) *and* a chat UI. What it does **not** contain is any deterministic quote *math*. See §6.

---

## 1. Data model — `prisma/schema.prisma`

Datasource is `postgresql` (`:18`), `DATABASE_URL`. No `prisma/migrations/` — schema applied via `prisma db push` (see §7 risk).

| Model | Key fields | Keys / indexes | Purpose |
|---|---|---|---|
| **WebhookEvent** `:24` | `id` cuid, `eventType`, `providerId`, `payload` (raw JSON string), `receivedAt` | `@@unique([eventType, providerId])`, `@@index([receivedAt])` | Append-only raw log. The unique pair **is** the idempotency guard. |
| **MonitoredLine** `:37` | `phoneNumberId` (Quo `PN…`), `number` E.164, `label`, `dispatcher`, `claimedByEmail` (lowercased MS email), `active` | `phoneNumberId @unique` | Claimed dispatch lines. Only these are ingested; also the ACL root (§5). |
| **AppUser** `:51` | `email @unique` (lowercased MS), `name`, `quoUserId` (`US…`), `quoUserName`, `autoLinkedAt` | `email @unique` | Dispatcher identity from Microsoft sign-in + its Quo match. (Named `AppUser`, not `User`.) |
| **Conversation** `:63` | `phoneNumberId?` (null in permissive mode), `counterparty` (technician phone, E.164), `quoConversationId?` (`CN…`), `lastEventAt` | `@@unique([phoneNumberId, counterparty])`, `@@index([lastEventAt])` | The **stable** unit — one tech thread on one line. Never split or merged. |
| **Job** `:81` | `conversationId` (cascade), `startsAt`, `locked`, `title`, `status` (default `open`), `addedContext`, `quoteDraft`, `quoteDraftedAt`, `quoteSources` (JSON), `checkoutNote`, `lastEventAt` | `@@index([conversationId, startsAt])` | A **time-boundary segment** of a conversation = one work order. |
| **Call** `:102` | `conversationId` (cascade), `quoCallId @unique`, `direction`, `durationSec`, `transcript`, `dialogue` (raw JSON), `summary` (JSON `{summary[],nextSteps[]}`), `recordingUrl`, `startedAt` | `quoCallId @unique`, `@@index([conversationId, startedAt])` | Upserted by `quoCallId` as transcript/summary/recording land in separate webhooks. |
| **Message** `:121` | `conversationId` (cascade), `quoMessageId @unique`, `direction`, `text`, `media` (JSON `[{type,url}]`), `senderNumber`, `createdAt` | `quoMessageId @unique`, `@@index([conversationId, createdAt])` | SMS/MMS. Inbound = tech's fix plan/pricing + photos. |

### Time-boundary segmentation rule (exactly as implemented)

`Message` and `Call` carry **`conversationId` only — never `jobId`**. Job membership is *derived*:

1. A Job owns every event whose **anchor** falls in the half-open interval `[job.startsAt, nextJob.startsAt)` — `context.ts:84-109`, `schema.prisma:79-80`.
2. **Anchors:** `Message.createdAt`; `Call.startedAt ?? Call.createdAt` (`segment.ts:201`, `context.ts:107`).
3. `jobForTimestamp(bounds, t)` (`segment.ts:39-47`) = greatest `startsAt <= t`. Events **earlier than the first boundary clamp to the first job** — nothing falls out of a segment.
4. Boundaries are only ever **opened forward**; events are never reassigned (`maybeOpenBoundary`, `segment.ts:219-274`). New `startsAt = max(event.at, latest.startsAt + 1ms)`, so boundaries strictly increase.
5. An event with `at < latest.startsAt` (late/out-of-order) **cannot** open a boundary (`:232`). The **first** content event of an empty current job always extends it (`:251`).
6. **There is no fixed time window.** `JOB_WINDOW_HOURS` appears in `README.md:34`, `DEPLOY.md:41` and `.env`, but is **referenced by zero lines of code**. See §9.

---

## 2. Event flow

**Receiver:** `src/app/api/webhooks/quo/route.ts` (`runtime="nodejs"`, `force-dynamic`); auth-exempt via `src/middleware.ts:14`.

1. `raw = await req.text()` **before** parsing — the signature is over exact bytes.
2. `signingSecretsFromEnv()` comma-splits `QUO_WEBHOOK_SIGNING_SECRETS` (`verify.ts:59`). Empty → **500**.
3. **HMAC multi-secret verify** (`src/lib/quo/verify.ts:17-56`): header `openphone-signature` = `hmac;1;<timestampMs>;<base64digest>`; requires ≥4 fields, scheme `hmac`; `compactBody = JSON.stringify(JSON.parse(raw))`; `signedData = ${ts}.${compactBody}`; `HMAC-SHA256(base64decode(secret), signedData)`; loops **every** configured secret with length-checked `crypto.timingSafeEqual`. Fail → **401**. ⚠ The timestamp is signed but never compared to `now` — **no replay window** (§9).
4. `JSON.parse` → 400 on failure. An `ingestEvent()` throw → **500**, deliberately, so Quo retries. `GET` returns a probe response.

**Types handled** — `parseEvent()` `src/lib/quo/types.ts:187-210`, zod, all `.passthrough()`, OpenPhone legacy `apiVersion: v4` shape (`data.object` + `data.deepLink`): `message.received`, `message.delivered`, `call.completed`, `call.recording.completed`, `call.transcript.completed`, `call.summary.completed`. Unknown type → `null` → `{handled:false}` → still HTTP 200 (no retry storm).

**Pipeline** — `src/lib/jobs/ingest.ts:252-311`:

- **Line scoping first** (`:261-267`): `getMonitoredLineNumberMap()` (active lines only). Non-empty map + `pnId` not in it → dropped as `filtered`. Empty map → **permissive mode**, everything ingested. `pnId` = `data.object.phoneNumberId` ?? deepLink regex `/\/inbox\/(PN[^/?]+)/` (`types.ts:174`).
- **Idempotency** (`:269-280`): `providerId = data.object.id ?? data.object.callId ?? "unknown"`; `webhookEvent.create()`; Prisma **P2002** → `{handled:true, deduped:true}` and the handler is skipped. Filtering precedes logging, so dropped events leave no `WebhookEvent` row.
- **Counterparty resolution** (`:58-92`) deliberately distrusts Quo's `direction` (unreliable Quo↔Quo): message → `from === lineNumber ? to : to === lineNumber ? from : direction-fallback`; call → `participants.find(p => p !== lineNumber)`, fallback `incoming ? p[0] : p[last]`. `isInboundMessage` = `to === lineNumber`.

**Upsert semantics:**

- `handleMessage` (`:114`): `message.upsert` by `quoMessageId` with `update: {}` (create-only). Non-empty text → `maybeOpenBoundary(kind:"message")`, else `touchJobForTimestamp`.
- `upsertCall` (`:160`) serves **both** `call.completed` and `call.recording.completed`. Existing row → coalescing update of `direction`/`durationSec`/`recordingUrl` (never nulls out a known value); else create with `startedAt = createdAt`, `recordingUrl` = first `recordings[].url`. **Calls never open a boundary themselves.**
- `handleTranscript` (`:206`): finds `Call` by `quoCallId`; **if absent, returns silently — the transcript is lost**. Assembles `transcript` from `dialogue[]`: `Dispatcher:` when `d.userId` is set, else `d.identifier ?? d.speaker ?? "Technician"`. Anchors at `call.startedAt ?? createdAt` and **can** open a boundary (`kind:"transcript"`).
- `handleSummary` (`:230`): same lookup-or-drop; normalizes `summary` (string | string[]) and stores `{summary, nextSteps}` JSON.

**Correlation algorithm (the real one)** — `src/lib/jobs/segment.ts:121-274`. Not a time window; an **LLM classifier**:

- Model `OPENROUTER_CLASSIFY_MODEL` (default `openai/gpt-4o-mini`), `temperature: 0`, `response_format: json_object`.
- Prompt (`SYSTEM`, `:121`) demands `{"action":"continue"|"new","title":"Site/Location — Problem"}` with a **strong CONTINUE bias**; `NEW` only for a clearly different property/unit/problem.
- Context = last `RECENT_EVENTS = 12` events of the *current segment*, each truncated to 200 chars; incoming text sliced to 1000 chars. `job.locked` (human-set) appends a stricter instruction (`:140`).
- **Fail-safe:** any LLM error → `{action:"extend"}` (`:171`) — ingestion never breaks and never spuriously splits. `parseJsonLoose` salvages `{...}` out of prose. Titles are written only when the job has none (`:268`).

**Manual correction:** `POST /api/conversations/[id]/boundary` (`mode: "split" | "set"`) and `POST /api/conversations/[id]/merge`; both set `locked: true`. Merge **deletes** the target Job row and folds its events into the previous segment by timestamp; the survivor inherits the target's draft only if it has none — otherwise the target's draft is destroyed.

---

## 3. `getJobContext()` — THE SEAM (`src/lib/jobs/context.ts:77-157`)

```ts
type JobContext = {
  jobId: string; status: string; title: string | null;
  counterparty: string;                    // technician's phone (E.164) — the correlation key
  createdAt: Date; lastEventAt: Date;
  call: { quoCallId: string; durationSec: number|null; transcript: string|null;
          summary: { summary: string[]; nextSteps: string[] } | null;
          recordingUrl: string|null } | null;
  messages: { direction: string; text: string|null; media: {type?:string|null; url:string}[];
              createdAt: Date }[];
  technicianMessages: { text: string|null; media: MediaItem[]; createdAt: Date }[];
  photos: string[];                        // every media URL in the segment (may expire)
  contextText: string;                     // ready-to-prompt blob
  quoteDraft: string|null; quoteDraftedAt: Date|null;
  quoteSources: { id: string; problem: string; trade: string; total: number|null; score: number }[];
};  // returns null if the job id doesn't exist
```

Assembly: load Job + Conversation → find `next` job (`startsAt > job.startsAt`, asc) → window `[lo, hi)` → messages filtered **in SQL**; calls loaded for the **whole conversation** then filtered **in JS** on the coalesced anchor (`:101-109`). Primary `call` = first with a transcript, else the first — **only one call per job is ever surfaced** (`:119`). `technicianMessages` = `direction === "incoming"`. `photos` = flatMap over *all* messages (both directions). `contextText` (`buildContextText`, `:169`) emits, in order: `=== CALL TRANSCRIPT ===`, `=== CALL SUMMARY ===` (+ `Next steps:`), `=== TECHNICIAN MESSAGES (fix plan / pricing) ===`, `=== PHOTOS ===` (raw URLs), `=== ADDED CONTEXT (dispatcher notes) ===` (from `Job.addedContext`).

---

## 4. Quo REST client — `src/lib/quo/client.ts`

Base `https://api.openphone.com/v1`. Auth: `QUO_API_KEY` sent **raw** in `Authorization` (no `Bearer`). Rate limit noted as 10 req/s. Dependency-free (reads `process.env`, no path aliases) so `scripts/` can import it.

| Export | Endpoint | Used by |
|---|---|---|
| `sendMessage({to[],from,content,userId?})` | `POST /messages` | **nothing** — dead |
| `listConversations()` | `GET /conversations` | `scripts/quo-peek.ts` |
| `listMessages({phoneNumberId,participants[]})` | `GET /messages` | `scripts/quo-peek.ts` |
| `listCalls({phoneNumberId,participants[]})` | `GET /calls` | `scripts/quo-peek.ts` |
| `getTranscript(callId)` | `GET /call-transcripts/{id}` | `scripts/quo-peek.ts` only |
| `getRecording(callId)` | `GET /call-recordings/{id}` | **nothing** — dead |
| `listPhoneNumbers()` | `GET /phone-numbers` | `quo/users.ts`, `scripts/quo-info.ts` |
| `listUsers()` | `GET /users` (paginated, 50/pg) | `quo/users.ts` |
| `createWebhook(type, body)` | `POST /webhooks/{messages\|calls\|call-transcripts\|call-summaries}` | `scripts/register-webhooks.ts` |
| `listWebhooks()` | `GET /webhooks` | **nothing** — dead |

---

## 5. Auth model

- **Provider:** Auth.js v5 `MicrosoftEntraID`, single-tenant, JWT sessions (`src/auth.config.ts`). Email = `profile.email || profile.preferred_username` (Entra ships empty `email` claims), lowercased. `pages.signIn = "/signin"`.
- **Edge split:** `middleware.ts` builds its own Prisma-free NextAuth from `authConfig`; matcher exempts `api/webhooks`, `api/health`, `api/auth`, `_next/*`, `favicon.ico`.
- **Auto-link** (`src/auth.ts` `events.signIn` → `src/lib/autolink.ts`): upserts `AppUser`, then matches against Quo. TTL **6 h** before re-querying; failures never block sign-in.
- **Match order** (`src/lib/quo/users.ts:130-174`): exact **email** → exact **full name** → **unique first name** from display name, with a *surname veto* (a known differing last name disqualifies). Ambiguity (≠1 hit) → `null`, surfaced as a warning on `/setup`.
- **Claiming:** each matched line upserts `MonitoredLine` with `active: true`. **Claim-preserving** — never overwrites a colleague's `claimedByEmail`. Only `force` ("Re-check Quo", `app/setup/actions.ts`) deactivates lines Quo no longer assigns to you. `autolink.ts` is the **only** writer of claims; the manual picker was deleted (`lib/lines.ts` trailing NOTE).
- **Visibility ACL** (`src/lib/access.ts`): `getViewer()` → `{email, isAdmin, lineIds}`. Admins from `ADMIN_EMAILS` see all. Others see only conversations whose `phoneNumberId` is in their claimed lines — **including inactive ones**, and **never** permissive/`null`-line conversations. `requireJobAccess` / `requireConversationAccess` gate every mutating route and return **404 (not 403)** on a foreign resource.

---

## 6. RAG / quote drafting — what actually exists

**It is Qdrant, not Pinecone.** `@pinecone-database/pinecone@^8` sits in `package.json` dependencies but is imported **nowhere** — dead dependency.

- `src/lib/ai/quotes.ts` — `searchQuotes(query, {topK=5, trade?})`: embeds via OpenRouter `/embeddings` (`text-embedding-3-small`, 1536-d), then `POST {QDRANT_URL}/collections/{QDRANT_COLLECTION ?? "seamless_quotes"}/points/search` with raw `fetch` (no SDK). The `trade` arg is **accepted and deliberately ignored** (`:112-114`, case-sensitivity concern). Payload mapping: `tech_reported`→problem, `trade`, `labor[].hours` summed, `labor[].tech_number` max, `incurred.trip`, `totals.grand_total`, `materials[]`, `required_to[]`, `full_quote_text`, `complexity`, `job_type`, `entity`.
- `src/lib/ai/brain.ts` — the operator-authored `SYSTEM_PROMPT` (Mode 1 consultation / Mode 2 quote, with the exact house template "Tech reported that… / Incurred: Trip $… / Required is to: / Repair: / Parts and materials: / Total $…"), one tool `vista_quotes`, agent loop up to **8** rounds, `dedupeSources` by best score. `draftQuoteFromContext(contextText)` forces Mode 2.
- `src/lib/ai/checkout.ts` — `generateCheckoutNote()`, one direct call, **no RAG**; `looksLikeQuote()` = contains "required is to" AND `/total\W{0,8}\$/`.
- `src/lib/ai/openrouter.ts` — `chat()` (tools, `response_format`) + `embed()`. Key env var is the typo'd **`Openrounter_API_KEY`** (falls back to `OPENROUTER_API_KEY`).
- **Routes:** `POST/PATCH /api/jobs/[id]/draft` (persists the quote *before* attempting the note; `maxDuration = 60`), `POST /api/jobs/[id]/checkout-note`, `PATCH /api/jobs/[id]/context`, `POST /api/chat`.
- **UI:** `components/QuotePanel.tsx` (generate/edit/save/sources), `CheckoutNote.tsx`, `AddContextBox.tsx`, `app/chat/ChatPanel.tsx` (394 lines — full conversational quote builder with downscaled image + PDF data-URL attachments), `app/conversations/[id]/page.tsx` (355 lines — thread segmented by job, with boundary/merge controls). `app/jobs/[id]/page.tsx` is now only a redirect to the conversation.

### ⚠ The quote **math** is not in this repo — and not in code anywhere

`grep` for `sales.?tax | overtime | \bOT\b | day.?rate | net.?30 | invoice | stripe | payment | markup | margin` across `src/` and `scripts/` returns **one hit**: a UI placeholder string in `components/AddContextBox.tsx:55`. There is **no** rate table, no OT multiplier, no day-rate rule, no tax computation, no payment-terms logic, no invoice model. Pricing is entirely **LLM-inferred**: the model reads `labor_hours`, `number_tech`, `trip_fee`, `total_cost` off the top-K historical Qdrant quotes and emits a `Total $` by unverified model arithmetic. If Jordan believes OT/day/tax/payment rules live "in the actual project", they live **outside this repo** — most likely baked into the historical prices in the Qdrant `seamless_quotes` corpus, or in an n8n workflow (note the `n8n-mcp` server in `.mcp.json` and the 4 unrelated `n8n…` webhooks referenced at `DEPLOY.md:59`).

---

## 7. Deploy / runtime

- **Vercel**, `vercel.json` = `{ framework: "nextjs" }` only. `next.config.mjs` sets `serverExternalPackages: ["@prisma/client","prisma"]`; every route pins `runtime="nodejs"` + `dynamic="force-dynamic"`. `maxDuration = 60` on `draft`, `checkout-note`, `chat`.
- **Build:** `"build": "prisma db push && next build"`, `"postinstall": "prisma generate"`.
- **DB:** Neon Postgres; **pooled** URL required on Vercel (`DEPLOY.md:76`). `src/lib/db.ts` reuses one `PrismaClient` across hot reloads.
- **Health:** `GET /api/health` → `{ok, counts:{jobs,calls,messages,events}}` (auth-exempt).
- **Env var names** (from `.env.example`; values not reproduced): `QUO_API_KEY`, `QUO_FROM_NUMBER`, `QUO_PHONE_NUMBER_ID`, `QUO_WEBHOOK_SIGNING_SECRETS`, `PUBLIC_BASE_URL`, `DATABASE_URL`, `JOB_WINDOW_HOURS` *(dead)*, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER`, `AUTH_SECRET`, `ADMIN_EMAILS`, `Openrounter_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_CLASSIFY_MODEL`, `OPENROUTER_EMBED_MODEL`, `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`. `.env.local` additionally carries the Neon/Vercel-injected `POSTGRES_*` / `PG*` / `DATABASE_URL_UNPOOLED` / `NEON_PROJECT_ID` / `VERCEL_OIDC_TOKEN` set.
- **Webhook registration:** `scripts/register-webhooks.ts` creates **4** webhooks against `<PUBLIC_BASE_URL>/api/webhooks/quo` with `resourceIds: ["*"]` (all lines — filtering is in-app, so claiming a new line needs no re-registration): `qb-messages`, `qb-calls`, `qb-transcripts`, `qb-summaries`. Each response's `key` is that webhook's base64 signing secret → the comma-separated `QUO_WEBHOOK_SIGNING_SECRETS`. Helpers: `npm run quo:info`, `npm run quo:peek`.

---

## 8. Integration options for The One

**(a) Consume Quotato as a sibling service (its DB / HTTP API).** Cheapest and fastest: already deployed, already receiving live webhooks, already ACL'd per dispatcher. The One reads `Conversation`/`Job`/`Message`/`Call` (or calls `getJobContext`) and never touches OpenPhone. Cost: two databases, two auth systems, cross-service joins for anything WO-shaped, and you inherit the Vercel 60 s function ceiling.

**(b) Absorb `src/lib/` into The One's monorepo as a module.** `lib/quo/*` and `lib/jobs/*` are clean and dependency-light (`zod`, `prisma`, `fetch`), and the client deliberately avoids path aliases. You get one DB, one session, and Job↔WO as a real FK instead of a phone-number join. Cost: port 7 Prisma models, re-register the 4 Quo webhooks at the new URL, redo the Entra redirect URIs — a real but bounded migration, and you then own the LLM segmenter's cost/latency.

**(c) Re-implement against OpenPhone directly.** Only worth it if The One's message model diverges sharply from conversation-first segmentation. You'd rewrite exactly the non-obvious parts already debugged here against real traffic: multi-secret HMAC with compact-JSON re-serialization, direction-distrusting counterparty logic, split-webhook call upsert.

> **Recommendation for the Messages-tab sprint: (a) now, (b) as the follow-up.** Read Quotato's Neon DB read-only (or add one `GET /api/jobs/[id]/context` handler — today only `PATCH` exists) and render the Messages tab from `Conversation` + `Job` immediately; do not block the sprint on a schema migration. Schedule (b) for the following sprint, once the tab has proven which fields you actually need.
>
> **Mapping a Job/Conversation to a WO.** The correlation key is **`Conversation.counterparty`** — the technician's phone in E.164 — which The One joins to its vendor/tech records. Then `Conversation` → that vendor's message thread, and each `Job` within it → one candidate WO (`Job.title` is already an AI "Site — Problem" label; `startsAt`/`lastEventAt` bound it). Add a nullable `workOrderId` to `Job` (or a side table in The One) and let a dispatcher confirm the link — the existing `boundary`/`merge` routes already provide split/merge when the LLM segments wrongly. Note `Conversation.phoneNumberId` can be `null` in permissive mode and those rows are invisible to non-admins, so scope reads to `phoneNumberId != null`.

---

## 9. Gaps / risks

**Doc↔code drift**
- `JOB_WINDOW_HOURS` is documented (`README.md:34`, `DEPLOY.md:41`) and set in `.env`, but **no code reads it**. Correlation is the LLM classifier in `segment.ts`. The docs describe a design that was replaced.
- **SQLite drift:** `README.md:46` ("creates the local SQLite db") and `:113-115` ("switch `provider` to `postgresql`") are obsolete — `schema.prisma:18` is already `postgresql`. `DEPLOY.md:78` has the correct story. `.gitignore` still carries SQLite rules and a stale `prisma/dev.db` sits in the tree.
- `README.md:88-95` describes ticking lines at `/setup`; the manual picker was **deleted** (commit `017b476`) — Setup is read-only and lines come only from auto-link.
- `README.md:13-15` ("only the Quo connection + correlation") has been false since the initial commit, which already shipped Qdrant + OpenRouter drafting.

**Security**
- **No replay protection.** `verify.ts` signs over the timestamp but never checks its freshness; a captured valid request replays forever. The only defense is the `WebhookEvent` unique constraint.
- **`.mcp.json` is git-tracked with live plaintext credentials** (an n8n API JWT and a Perplexity key). Rotate and untrack.
- `build` runs `prisma db push` every deploy with **no migration history** — a schema edit can silently drop a production column. Move to `prisma migrate`.

**Dead code / half-built**
- Unused exports: `sendMessage()`, `getRecording()`, `listWebhooks()` (`lib/quo/client.ts`), `getActiveMonitoredLineIds()` (`lib/lines.ts`). **Sending a finished quote back to the tech is not wired**, despite `README.md:118`.
- `@pinecone-database/pinecone` dependency, zero imports.
- `Job.status` declares `open | drafting | drafted | sent | closed`; only `"open"` and `"drafted"` are ever written. `StatusPill` styles a `drafting` state that is never persisted.

**Correctness / data-loss**
- `call.transcript.completed` / `call.summary.completed` arriving **before** the call row exists are **silently dropped** (`ingest.ts:208`, `:232`). `getTranscript()`/`getRecording()` exist for backfill but nothing calls them — no retry, no reconciliation job.
- `getJobContext` surfaces **only one call per job** (`context.ts:119`); a segment with two calls loses the second entirely.
- `context.ts:101-109` loads **every** call in a conversation into memory to filter in JS — fine today, a problem for long-lived threads.
- Line-filtered events are dropped **before** the `WebhookEvent` insert, so there is no audit trail of what was ignored.
- `message.delivered` (outbound, the dispatcher's own text) also runs `maybeOpenBoundary` — a dispatcher message can open a new job.
- `photos` includes outbound media but is presented as the technician's photos.
- Quo media URLs expire and nothing re-hosts them (`README.md:116`) — drafts referencing photos rot.
- `merge` **deletes** the target Job row; if both jobs have drafts, the target's is destroyed.
- Every content-bearing event costs an LLM call (segmentation): cost and latency scale with message volume, and an OpenRouter outage silently degrades to "never split".
