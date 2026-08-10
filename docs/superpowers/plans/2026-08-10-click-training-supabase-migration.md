# Click-Training Direct-to-Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the n8n-based click-training ingestion path (Chrome plugins → n8n webhook → Postgres upsert) with a direct-to-Supabase path (Chrome plugins → Supabase REST API), fixing the redundant full-state-per-click payload along the way.

**Architecture:** Two Chrome extensions (`smartai-plugin-topicus-latest`, `smartai-plugin-healthconnected-latest`) currently re-POST their *entire* accumulated click state to a hardcoded n8n webhook on every single click. This plan (1) adds an append-only `click_events` table plus a trigger-maintained `clickmaps` summary table directly in Supabase, secured by RLS so the plugins can only ever `INSERT`, then (2) changes both plugins to send a single delta event per click straight to Supabase's REST API instead of the n8n webhook, removing all client-side state accumulation.

**Tech Stack:** Supabase (Postgres + PostgREST + Row Level Security), vanilla JS Chrome Manifest V3 content scripts (no build step, no test runner in either plugin repo today).

## Global Constraints

- The Supabase `anon` key must never be able to `SELECT`/`UPDATE`/`DELETE` on any table involved — `INSERT`-only on `click_events`, zero grants at all on `clickmaps`.
- No `service_role` key anywhere in client-side (plugin) code.
- Existing DOM click-detection logic (selectors, event listeners, categories `abcd`/`triagecriteria`/`ingangsklachten`) in both plugins must not change — only how the detected click is transmitted changes.
- `category` values are exactly `abcd`, `triagecriteria`, `ingangsklachten` (already used verbatim in both plugins' code).
- Neither plugin repo has a test runner or build step today (confirmed: no `package.json`, no test framework). Verification steps in the plugin tasks are manual (browser network tab / Supabase table inspection), not automated.
- No local Supabase CLI/dev project exists. All schema changes ship as plain `.sql` files applied by hand via the Supabase SQL editor (or `supabase db push` if you later adopt the CLI).
- `topicus_id` (Topicus) is assumed stable/unique per call. HealthConnected's `CALL_ID` is a client-generated UUID regenerated on every page load (not yet tied to a real HealthConnected session key) — this is a known, accepted limitation, not something this plan fixes.
- Timestamps sent to Postgres must be unambiguous UTC (`new Date().toISOString()`), not the existing `nowAmsterdamISO()` helper — that function formats Amsterdam wall-clock time *without* a UTC offset, which a `timestamptz` column would silently misinterpret as UTC, shifting every timestamp by 1-2 hours. This plan removes `nowAmsterdamISO()` from both plugins (it becomes unused once client-side state accumulation is removed).

---

## Task Group A — Supabase schema, trigger, and RLS (foundation)

These three `.sql` files must be applied, in order, via the Supabase SQL editor before either plugin is migrated.

### Task 1: Create `click_events` and `clickmaps` tables

**Files:**
- Create: `supabase/migrations/0001_click_events_schema.sql`

**Interfaces:**
- Produces: table `public.click_events` (append-only log, one row per click) and table `public.clickmaps` (one row per call, holding the merged JSON clickmap) — consumed by Task 2's trigger and by both plugins' `INSERT`s.

- [ ] **Step 1: Write the schema SQL**

```sql
-- 0001_click_events_schema.sql

create table if not exists public.click_events (
  id bigint generated always as identity primary key,
  source text not null check (source in ('topicus', 'healthconnected')),
  session_id text not null,
  gp_name text,
  category text not null check (category in ('abcd', 'triagecriteria', 'ingangsklachten')),
  field_key text not null,
  value text not null,
  client_timestamp timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists click_events_session_idx
  on public.click_events (source, session_id);

create table if not exists public.clickmaps (
  source text not null,
  session_id text not null,
  gp_name text,
  clickmap jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (source, session_id)
);
```

- [ ] **Step 2: Apply it**

Run: paste the file contents into the Supabase SQL editor and execute.
Expected: two new tables appear under Table Editor → `public` schema: `click_events` (empty) and `clickmaps` (empty).

- [ ] **Step 3: Verify the check constraints**

Run in the SQL editor:
```sql
insert into public.click_events (source, session_id, category, field_key, value, client_timestamp)
values ('unknown_source', 'x', 'abcd', 'test', 'Ja', now());
```
Expected: FAILS with `new row for relation "click_events" violates check constraint "click_events_source_check"`. This confirms the constraint is active. Do not leave this row committed — the failed statement doesn't insert anything, so no cleanup needed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_click_events_schema.sql
git commit -m "feat: add click_events and clickmaps tables"
```

---

### Task 2: Create the merge trigger

Every `INSERT` into `click_events` must fold that one delta into the corresponding `clickmaps` row, producing the same `{meta: {started_at, updated_at}, abcd: {...}, triagecriteria: {...}, ingangsklachten: {...}}` shape the plugins used to build client-side — but now computed server-side from trusted deltas.

**Files:**
- Create: `supabase/migrations/0002_merge_click_event_trigger.sql`

**Interfaces:**
- Consumes: `public.click_events` row (`source`, `session_id`, `gp_name`, `category`, `field_key`, `value`, `client_timestamp`) from Task 1.
- Produces: `public.clickmaps.clickmap` jsonb shaped as `{"meta": {"started_at": <ts>, "updated_at": <ts>}, "abcd": {"<field_key>": {"text": <value>, "timestamp": <ts>}, ...}, "triagecriteria": {...}, "ingangsklachten": {...}}` — this is the "complete clickmap" consumed by training-time code.

- [ ] **Step 1: Write the trigger function and trigger**

```sql
-- 0002_merge_click_event_trigger.sql

create or replace function public.merge_click_event_into_clickmap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing jsonb;
  category_map jsonb;
begin
  select clickmap into existing
  from public.clickmaps
  where source = new.source and session_id = new.session_id
  for update;

  if existing is null then
    existing := jsonb_build_object(
      'meta', jsonb_build_object('started_at', new.client_timestamp)
    );
  end if;

  category_map := coalesce(existing -> new.category, '{}'::jsonb);

  if new.value = 'deselected' then
    category_map := category_map - new.field_key;
  else
    category_map := category_map || jsonb_build_object(
      new.field_key,
      jsonb_build_object('text', new.value, 'timestamp', new.client_timestamp)
    );
  end if;

  existing := jsonb_set(existing, array[new.category], category_map, true);
  existing := jsonb_set(existing, array['meta', 'updated_at'], to_jsonb(new.client_timestamp), true);

  insert into public.clickmaps (source, session_id, gp_name, clickmap, updated_at)
  values (new.source, new.session_id, new.gp_name, existing, new.client_timestamp)
  on conflict (source, session_id) do update
    set clickmap = excluded.clickmap,
        gp_name = coalesce(excluded.gp_name, public.clickmaps.gp_name),
        updated_at = excluded.updated_at;

  return new;
end;
$$;

drop trigger if exists click_events_merge_trigger on public.click_events;

create trigger click_events_merge_trigger
after insert on public.click_events
for each row execute function public.merge_click_event_into_clickmap();
```

- [ ] **Step 2: Apply it**

Run: paste into the Supabase SQL editor and execute.
Expected: no errors; `public.merge_click_event_into_clickmap` appears under Database → Functions, and `click_events_merge_trigger` appears under `click_events`'s triggers.

- [ ] **Step 3: Verify merge behavior (first event, second event, deselect)**

Run in the SQL editor, one statement at a time:
```sql
insert into public.click_events (source, session_id, gp_name, category, field_key, value, client_timestamp)
values ('topicus', 'test-call-1', 'Test Huisarts', 'abcd', 'circulation_kleur', 'Nee', '2026-08-10T10:00:00Z');

select clickmap from public.clickmaps where source = 'topicus' and session_id = 'test-call-1';
```
Expected: one row, `clickmap` = `{"meta": {"started_at": "2026-08-10T10:00:00+00:00", "updated_at": "2026-08-10T10:00:00+00:00"}, "abcd": {"circulation_kleur": {"text": "Nee", "timestamp": "2026-08-10T10:00:00+00:00"}}}`.

```sql
insert into public.click_events (source, session_id, gp_name, category, field_key, value, client_timestamp)
values ('topicus', 'test-call-1', 'Test Huisarts', 'triagecriteria', 'bewustzijn', 'Ja', '2026-08-10T10:00:05Z');

select clickmap from public.clickmaps where source = 'topicus' and session_id = 'test-call-1';
```
Expected: same row now also has a `"triagecriteria": {"bewustzijn": {"text": "Ja", "timestamp": "2026-08-10T10:00:05+00:00"}}` key, `meta.started_at` unchanged (still `10:00:00`), `meta.updated_at` now `10:00:05`.

```sql
insert into public.click_events (source, session_id, gp_name, category, field_key, value, client_timestamp)
values ('topicus', 'test-call-1', 'Test Huisarts', 'abcd', 'circulation_kleur', 'deselected', '2026-08-10T10:00:10Z');

select clickmap from public.clickmaps where source = 'topicus' and session_id = 'test-call-1';
```
Expected: `"abcd"` is now `{}` (the `circulation_kleur` key was removed), `triagecriteria.bewustzijn` still present, `meta.updated_at` now `10:00:10`.

- [ ] **Step 4: Clean up test rows**

```sql
delete from public.click_events where session_id = 'test-call-1';
delete from public.clickmaps where session_id = 'test-call-1';
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_merge_click_event_trigger.sql
git commit -m "feat: add trigger to merge click events into clickmaps summary"
```

---

### Task 3: Lock down access with Row Level Security

**Files:**
- Create: `supabase/migrations/0003_row_level_security.sql`

**Interfaces:**
- Consumes: tables from Task 1.
- Produces: the security boundary both plugins' `anon`-key `INSERT`s rely on.

- [ ] **Step 1: Write the RLS SQL**

```sql
-- 0003_row_level_security.sql

alter table public.click_events enable row level security;
alter table public.clickmaps enable row level security;

-- Defense in depth: start from zero grants, then add back exactly what's needed.
revoke all on public.click_events from anon, authenticated;
revoke all on public.clickmaps from anon, authenticated;

grant usage on schema public to anon;
grant insert on public.click_events to anon;

create policy "anon can insert click events"
  on public.click_events
  for insert
  to anon
  with check (true);

-- No policies are created for anon on clickmaps: it has zero grants and zero
-- policies, so anon cannot read, insert, update, or delete it at all. Only the
-- SECURITY DEFINER trigger from Task 2 (running as the function owner) can
-- write to it.
```

- [ ] **Step 2: Apply it**

Run: paste into the Supabase SQL editor and execute.

- [ ] **Step 3: Verify anon can insert but not read**

Run in the SQL editor:
```sql
set role anon;

insert into public.click_events (source, session_id, gp_name, category, field_key, value, client_timestamp)
values ('topicus', 'rls-test', 'Test Huisarts', 'abcd', 'circulation_kleur', 'Nee', now());
```
Expected: succeeds (1 row inserted).

```sql
select * from public.click_events where session_id = 'rls-test';
```
Expected: FAILS with `permission denied for table click_events` (no `SELECT` grant was given to `anon`).

```sql
select * from public.clickmaps where session_id = 'rls-test';
```
Expected: FAILS with `permission denied for table clickmaps`.

```sql
reset role;
delete from public.click_events where session_id = 'rls-test';
delete from public.clickmaps where session_id = 'rls-test';
```

- [ ] **Step 4: Verify the real REST endpoint works end-to-end**

Run (replace `YOUR-PROJECT-REF` and `YOUR-ANON-KEY` with the actual values from Supabase → Project Settings → API):
```bash
curl -i -X POST "https://YOUR-PROJECT-REF.supabase.co/rest/v1/click_events" \
  -H "apikey: YOUR-ANON-KEY" \
  -H "Authorization: Bearer YOUR-ANON-KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d '{"source":"topicus","session_id":"curl-test","gp_name":"Test Huisarts","category":"abcd","field_key":"circulation_kleur","value":"Nee","client_timestamp":"2026-08-10T10:00:00Z"}'
```
Expected: `HTTP/2 201` with an empty body (because of `Prefer: return=minimal`). Then in the Supabase Table Editor (which reads as an admin, bypassing RLS), confirm one new row in `click_events` and a matching merged row in `clickmaps` for `session_id = 'curl-test'`. Delete both test rows afterward via the Table Editor.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0003_row_level_security.sql
git commit -m "feat: lock down click_events/clickmaps with RLS, insert-only for anon"
```

---

## Task Group B — Migrate `smartai-plugin-topicus-latest`

Repo: `E:\Auxilio\smartai-plugin-topicus-latest`

### Task 4: Add Supabase config and update host permissions

**Files:**
- Modify: `config.js` (currently 2 lines)
- Modify: `manifest.json:15-17`

**Interfaces:**
- Produces: globals `SUPABASE_URL`, `SUPABASE_ANON_KEY`, readable by `content.js` (loaded after `config.js` per `manifest.json:28-31`).

- [ ] **Step 1: Add Supabase constants to `config.js`**

Replace the full contents of `config.js` with:
```js
// GP practice name is derived from the URL hostname (first subdomain segment).
const GP_CONFIG = {};

// Supabase project storing click events for AI training data.
// Replace with this project's actual values from Supabase -> Project Settings -> API.
const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
```

- [ ] **Step 2: Point host_permissions at Supabase instead of n8n**

In `manifest.json`, replace:
```json
    "host_permissions": [
        "https://auxilio.app.n8n.cloud/*"
    ],
```
with:
```json
    "host_permissions": [
        "https://YOUR-PROJECT-REF.supabase.co/*"
    ],
```
(use the same `YOUR-PROJECT-REF` as in `config.js`).

- [ ] **Step 3: Manual verification**

Load the unpacked extension (`chrome://extensions` → Developer mode → Load unpacked), open `chrome://extensions`, click "Details" on the plugin, confirm no manifest errors are shown and the host permission listed is the Supabase URL, not the old n8n URL.

- [ ] **Step 4: Commit**

```bash
git add config.js manifest.json
git commit -m "feat: point plugin at Supabase instead of n8n webhook"
```

---

### Task 5: Replace full-state webhook POST with a single delta insert

Removes all client-side state accumulation (`abcdState`, `updateAbcdState`, `buildAggregatedJson`, `nowAmsterdamISO`) and the n8n `callWebhook` call, replacing them with one function that sends exactly the click that just happened straight to Supabase.

**Files:**
- Modify: `content.js:9-95` (aggregated state, helpers, state management, webhook)
- Modify: `content.js:214-220` (top-frame message listener)

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_ANON_KEY` from Task 4; `TOPICUS_ID` (existing, set at `content.js:212`).
- Produces: `postClickEvent(category, label, value)` — posts one row to `public.click_events`.

- [ ] **Step 1: Replace lines 9-95**

Current (`content.js:9-95`):
```js
// --- 2. AGGREGATED STATE (TOP FRAME ONLY) ---
let abcdState = {
	meta: {
		started_at: nowAmsterdamISO(),
		updated_at: null,
	},
	abcd: {},
	ingangsklachten: {},
	triagecriteria: {},
};

// --- 3. HELPER FUNCTIONS ---

function normalizeKey(label) {
	if (!label) return "unknown";
	return (
		label
			.toLowerCase()
			// Replace non-alphanumeric chars (like , or :) with _
			.replace(/[^a-z0-9]+/g, "_")
			// Remove leading/trailing _
			.replace(/^_|_$/g, "")
	);
}

function nowAmsterdamISO() {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone: "Europe/Amsterdam",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
		.format(new Date())
		.replace(" ", "T");
}

// --- 4. STATE MANAGEMENT (TOP FRAME ONLY) ---

function updateAbcdState(payload) {
	const { category, label, value } = payload;
	const key = normalizeKey(label);

	if (!abcdState[category]) {
		abcdState[category] = {};
	}

	if (value === "deselected") {
		delete abcdState[category][key];
	} else {
		abcdState[category][key] = {
			text: value,
			timestamp: nowAmsterdamISO(),
		};
	}

	abcdState.meta.updated_at = nowAmsterdamISO();
}

function buildAggregatedJson() {
	return {
		topicus_id: TOPICUS_ID,
		gp_name: window.location.hostname.split(".")[0],
		abcd: abcdState,
	};
}

// --- 5. WEBHOOK ---

async function callWebhook(json) {
	try {
		const resp = await fetch(
			"https://auxilio.app.n8n.cloud/webhook/41f8eb1d-cbd8-47e7-b305-a57b3afda7c2",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(json),
			}
		);
		return resp.ok;
	} catch (err) {
		console.error("Webhook error:", err);
		return false;
	}
}
```

New:
```js
// --- 2. HELPER FUNCTIONS ---

function normalizeKey(label) {
	if (!label) return "unknown";
	return (
		label
			.toLowerCase()
			// Replace non-alphanumeric chars (like , or :) with _
			.replace(/[^a-z0-9]+/g, "_")
			// Remove leading/trailing _
			.replace(/^_|_$/g, "")
	);
}

// --- 3. SUPABASE INGEST (TOP FRAME ONLY) ---

async function postClickEvent(category, label, value) {
	try {
		const resp = await fetch(`${SUPABASE_URL}/rest/v1/click_events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: SUPABASE_ANON_KEY,
				Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
				Prefer: "return=minimal",
			},
			body: JSON.stringify({
				source: "topicus",
				session_id: TOPICUS_ID,
				gp_name: window.location.hostname.split(".")[0],
				category,
				field_key: normalizeKey(label),
				value,
				client_timestamp: new Date().toISOString(),
			}),
		});
		return resp.ok;
	} catch (err) {
		console.error("Supabase click ingest error:", err);
		return false;
	}
}
```

- [ ] **Step 2: Replace the top-frame message listener at lines 214-220**

Current:
```js
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || data.type !== "TRACK_CLICK") return;

		updateAbcdState(data.payload);
		callWebhook(buildAggregatedJson());
	});
```

New:
```js
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || data.type !== "TRACK_CLICK") return;

		const { category, label, value } = data.payload;
		postClickEvent(category, label, value);
	});
```

- [ ] **Step 3: Manual verification**

1. Reload the unpacked extension in `chrome://extensions`.
2. Open a real (or test) Topicus triage page matching the content script's `matches` patterns, open DevTools → Network tab, filter on your Supabase project domain.
3. Click one ABCD button. Confirm a `POST` request fires to `https://YOUR-PROJECT-REF.supabase.co/rest/v1/click_events` with status `201`, and its request body has exactly the fields `source`, `session_id`, `gp_name`, `category`, `field_key`, `value`, `client_timestamp` (no `abcd`/`meta` nesting — that's built server-side now).
4. In the Supabase Table Editor, confirm a new `click_events` row appeared, and the corresponding `clickmaps` row for that `topicus_id` now includes this click under the right category.
5. Click the same button again to toggle it off (if the UI supports deselection) and confirm the `clickmaps` row's category no longer contains that field.

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat: send click deltas straight to Supabase instead of aggregated n8n webhook"
```

---

## Task Group C — Migrate `smartai-plugin-healthconnected-latest`

Repo: `E:\Auxilio\smartai-plugin-healthconnected-latest`

Same migration as Task Group B, applied to this plugin's equivalent code. The DOM click-detection logic (`handleInteraction`, `scanTriageStepContainer`, the `change` listener) is untouched — only state accumulation and transmission change.

### Task 6: Add Supabase config and update host permissions

**Files:**
- Modify: `config.js` (currently 3 lines)
- Modify: `manifest.json:15-18`

**Interfaces:**
- Produces: globals `SUPABASE_URL`, `SUPABASE_ANON_KEY`, readable by `content.js`.

- [ ] **Step 1: Add Supabase constants to `config.js`**

Replace the full contents of `config.js` with:
```js
const GP_CONFIG = {
	name: "Amstelland",
};

// Supabase project storing click events for AI training data.
// Replace with this project's actual values from Supabase -> Project Settings -> API.
const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
```

- [ ] **Step 2: Point host_permissions at Supabase instead of n8n**

In `manifest.json`, replace:
```json
    "host_permissions": [
        "https://auxilio.app.n8n.cloud/*",
        "https://*.healthconnected.nl/*"
    ],
```
with:
```json
    "host_permissions": [
        "https://YOUR-PROJECT-REF.supabase.co/*",
        "https://*.healthconnected.nl/*"
    ],
```

- [ ] **Step 3: Manual verification**

Same as Task 4 Step 3: load unpacked, confirm no manifest errors, confirm the host permission is now the Supabase URL.

- [ ] **Step 4: Commit**

```bash
git add config.js manifest.json
git commit -m "feat: point plugin at Supabase instead of n8n webhook"
```

---

### Task 7: Replace full-state webhook POST with a single delta insert

> **Superseded by commit `4f37e21` (and Topicus's `76c6c0b`):** while this branch was in
> progress, `master` redesigned session identity into `SESSION_ID` (stable merge key,
> assigned once per triage session) plus a separate, optionally-absent `CALL_ID`
> (phone-derived, for later call-audio matching). The actual implementation sends
> `session_id: SESSION_ID` and `call_id: CALL_ID` (when known), NOT `session_id: CALL_ID`
> as shown below — the code blocks in this task are historical, not current. See the
> reconciliation commit messages for the full rationale.

**Files:**
- Modify: `content.js:9-95` (aggregated state, helpers, state management, webhook)
- Modify: `content.js:192-198` (top-frame message listener)

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_ANON_KEY` from Task 6; `CALL_ID` (existing, set at `content.js:7`).
- Produces: `postClickEvent(category, label, value)` — posts one row to `public.click_events`.

- [ ] **Step 1: Replace lines 9-95**

Current (`content.js:9-95`):
```js
// --- 2. AGGREGATED STATE (TOP FRAME ONLY) ---
let abcdState = {
	meta: {
		started_at: nowAmsterdamISO(),
		updated_at: null,
	},
	abcd: {},
	ingangsklachten: {},
	triagecriteria: {},
};

// --- 3. HELPER FUNCTIONS ---

function normalizeKey(label) {
	if (!label) return "unknown";
	return (
		label
			.toLowerCase()
			// Replace non-alphanumeric chars (like , or :) with _
			.replace(/[^a-z0-9]+/g, "_")
			// Remove leading/trailing _
			.replace(/^_|_$/g, "")
	);
}

function nowAmsterdamISO() {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone: "Europe/Amsterdam",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
		.format(new Date())
		.replace(" ", "T");
}

// --- 4. STATE MANAGEMENT (TOP FRAME ONLY) ---

function updateAbcdState(payload) {
	const { category, label, value } = payload;
	const key = normalizeKey(label);

	if (!abcdState[category]) {
		abcdState[category] = {};
	}

	if (value === "deselected") {
		delete abcdState[category][key];
	} else {
		abcdState[category][key] = {
			text: value,
			timestamp: nowAmsterdamISO(),
		};
	}

	abcdState.meta.updated_at = nowAmsterdamISO();
}

function buildAggregatedJson() {
	return {
		...(CALL_ID ? { call_id: CALL_ID } : {}),
		gp_name: GP_CONFIG.name,
		abcd: abcdState,
	};
}

// --- 5. WEBHOOK ---

async function callWebhook(json) {
	try {
		const resp = await fetch(
			"https://auxilio.app.n8n.cloud/webhook/healthconnected",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(json),
			}
		);
		return resp.ok;
	} catch (err) {
		console.error("Webhook error:", err);
		return false;
	}
}
```

New:
```js
// --- 2. HELPER FUNCTIONS ---

function normalizeKey(label) {
	if (!label) return "unknown";
	return (
		label
			.toLowerCase()
			// Replace non-alphanumeric chars (like , or :) with _
			.replace(/[^a-z0-9]+/g, "_")
			// Remove leading/trailing _
			.replace(/^_|_$/g, "")
	);
}

// --- 3. SUPABASE INGEST (TOP FRAME ONLY) ---

async function postClickEvent(category, label, value) {
	try {
		const resp = await fetch(`${SUPABASE_URL}/rest/v1/click_events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: SUPABASE_ANON_KEY,
				Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
				Prefer: "return=minimal",
			},
			body: JSON.stringify({
				source: "healthconnected",
				session_id: CALL_ID,
				gp_name: GP_CONFIG.name,
				category,
				field_key: normalizeKey(label),
				value,
				client_timestamp: new Date().toISOString(),
			}),
		});
		return resp.ok;
	} catch (err) {
		console.error("Supabase click ingest error:", err);
		return false;
	}
}
```

- [ ] **Step 2: Replace the top-frame message listener at lines 192-198**

Current:
```js
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || data.type !== "TRACK_CLICK") return;

		updateAbcdState(data.payload);
		callWebhook(buildAggregatedJson());
	});
```

New:
```js
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || data.type !== "TRACK_CLICK") return;

		const { category, label, value } = data.payload;
		postClickEvent(category, label, value);
	});
```

- [ ] **Step 3: Manual verification**

1. Reload the unpacked extension.
2. Open a HealthConnected triage page, DevTools → Network tab filtered on the Supabase domain.
3. Click one ABCD/triage button. Confirm a `POST` to `.../rest/v1/click_events` returns `201` with the same flat field shape as Task 5 Step 3, `source` = `"healthconnected"`, `session_id` = the current `CALL_ID`.
4. Navigate to a triage step that pre-populates selected criteria (the step the `MutationObserver`/`scanTriageStepContainer` handles) and confirm those auto-detected selections also produce `POST` requests without you clicking anything.
5. Uncheck one entry-complaint checkbox and confirm a `value: "deselected"` event is sent and the field disappears from the `clickmaps` row's `ingangsklachten`.

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat: send click deltas straight to Supabase instead of aggregated n8n webhook"
```

---

## Out of scope (explicitly not part of this plan)

- Fixing HealthConnected's `CALL_ID` regeneration on page reload — accepted limitation until HealthConnected provides a real session key.
- Retry/backoff on failed `postClickEvent` calls — matches today's fire-and-forget behavior; not requested.
- Per-installation auth/rate-limiting beyond the shared anon key + RLS (would need a Supabase Edge Function gatekeeper — discussed as an alternative, not chosen).
- Any change to `smartai-backend` — this flow does not touch that repo.
- Retiring the n8n workflow itself (turning off the webhook, deleting it from n8n) — do that once both plugins are confirmed working against Supabase in production use, as a separate cleanup step.
