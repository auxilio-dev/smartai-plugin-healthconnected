// ================================
// content.js — TARGET SPECIFIC ROW (LI)
// ================================

// --- 1. GLOBAL VARIABLES ---
const IS_TOP = window === window.top;
let CALL_ID = crypto.randomUUID();

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
		if (!resp.ok) {
			console.error("Supabase click ingest failed:", resp.status, await resp.text());
		}
		return resp.ok;
	} catch (err) {
		console.error("Supabase click ingest error:", err);
		return false;
	}
}

// --- 6. UNIVERSAL INTERACTION HANDLER (ALL FRAMES) ---

function handleInteraction(event) {
	const target = event.target;

	// HealthConnected ABCD/Triage buttons are <a mat-button class="btn ..."> inside hc-triage-criterium
	const button = target.closest("a.btn");
	if (!button) return;

	const criterium = button.closest("hc-triage-criterium");
	if (!criterium) return;

	const value = button.title || button.querySelector(".mat-button-wrapper")?.textContent.trim() || "unknown";
	const criteriumLabel = criterium.querySelector(".w-20 strong")?.textContent.trim() || "unknown";

	// Section label (e.g. "Airway", "Breathing") sits as a direct sibling above hc-triage-criterium
	const col = criterium.closest(".col");
	const sectionLabel = col?.querySelector(".text-dimmed.cursor-pointer")?.textContent.trim() || "";

	const uniqueLabel = sectionLabel ? `${sectionLabel}: ${criteriumLabel}` : criteriumLabel;
	const category = criterium.closest("hc-abcd-container") ? "abcd" : "triagecriteria";

	window.top.postMessage(
		{
			type: "TRACK_CLICK",
			payload: { category, label: uniqueLabel, value },
		},
		"*"
	);
}

document.addEventListener("click", handleInteraction, {
	capture: true,
	passive: true,
});

// --- 6b. AUTO-SCAN WHEN TRIAGE STEP APPEARS (pre-populated values) ---

function scanTriageStepContainer(container) {
	container.querySelectorAll("hc-triage-criterium").forEach((criterium) => {
		const selected = criterium.querySelector("a.btn.mat-selected");
		if (!selected) return;

		const value = selected.title || selected.querySelector(".mat-button-wrapper")?.textContent.trim();
		if (!value) return;

		const criteriumLabel = criterium.querySelector(".w-20 strong")?.textContent.trim() || "unknown";
		const col = criterium.closest(".col");
		const sectionLabel = col?.querySelector(".text-dimmed.cursor-pointer")?.textContent.trim() || "";
		const uniqueLabel = sectionLabel ? `${sectionLabel}: ${criteriumLabel}` : criteriumLabel;

		window.top.postMessage(
			{ type: "TRACK_CLICK", payload: { category: "triagecriteria", label: uniqueLabel, value } },
			"*"
		);
	});
}

new MutationObserver((mutations) => {
	for (const mutation of mutations) {
		for (const node of mutation.addedNodes) {
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			const container = node.matches?.("hc-triage-step-container")
				? node
				: node.querySelector?.("hc-triage-step-container");
			if (container) scanTriageStepContainer(container);
		}
	}
}).observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener("change", (event) => {
	const checkbox = event.target.closest("input.mat-checkbox-input");
	if (!checkbox) return;
	if (!checkbox.closest("hc-entry-complaints-component")) return;

	const matCheckbox = checkbox.closest("mat-checkbox");
	const labelEl = matCheckbox?.querySelector(".mat-checkbox-label .text-truncate");
	const labelText = labelEl ? labelEl.textContent.trim() : "unknown";

	window.top.postMessage(
		{
			type: "TRACK_CLICK",
			payload: {
				category: "ingangsklachten",
				label: labelText,
				value: checkbox.checked ? "selected" : "deselected",
			},
		},
		"*"
	);
}, { capture: true });

// --- 7. TOP FRAME INITIALIZATION ---

if (IS_TOP) {
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || data.type !== "TRACK_CLICK") return;

		const { category, label, value } = data.payload;
		postClickEvent(category, label, value);
	});

	(function createSidePanel() {
		if (document.getElementById("abcd-sidebar")) return;
		const panel = document.createElement("div");
		panel.id = "abcd-sidebar";
		Object.assign(panel.style, {
			position: "fixed",
			top: "28px",
			right: "207px", /* 200px from the right edge */
			width: "39px",
			height: "39px",
			backgroundColor: "#2c3e50",
			borderRadius: "5px",
			zIndex: "999999",
			display: "flex", /* Use flexbox to center content */
			justifyContent: "center",
			alignItems: "center",
			fontSize: "18px", /* Adjust font size for the dot */
		});
		panel.innerHTML = `🟢`;
		document.body.appendChild(panel);

		window.addEventListener("message", (e) => {
			if (e.data.type === "TRACK_CLICK") {
				const log = document.getElementById("log");
				if (log) log.innerText = `Last: ${e.data.payload.label}`;
			}
		});
	})();
}
