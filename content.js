// ================================
// content.js — TARGET SPECIFIC ROW (LI)
// ================================

// --- 1. GLOBAL VARIABLES ---
const IS_TOP = window === window.top;
// TODO: Replace with call_id provided by HealthConnected once their API supports it
let CALL_ID = null;

// Whether a triage session is currently active
let isTriageActive = false;

// --- 2. AGGREGATED STATE (TOP FRAME ONLY) ---
let abcdState = {
	meta: {
		started_at: null,
		updated_at: null,
		urgency_score: null,
		altered_urgency_score: null,
		altered_urgency_reason: null,
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

function extractPhoneCallId(input) {
	const el = input || document.querySelector("input[data-qa='triage.contact.form.phonenumber']");
	if (!el || !el.value) return false;
	const digits = el.value.replace(/\D/g, "");
	if (digits.length >= 5) {
		// TODO: Replace with call_id from HealthConnected event once available
		CALL_ID = digits.slice(-5);
		return true;
	}
	return false;
}

function resetState() {
	// Temporary call_id — overwritten with phone last-5 when Patient tab loads.
	// TODO: Replace entirely with call_id from HealthConnected event once available
	CALL_ID = crypto.randomUUID();
	abcdState = {
		meta: {
			started_at: nowAmsterdamISO(),
			updated_at: null,
			urgency_score: null,
			altered_urgency_score: null,
			altered_urgency_reason: null,
		},
		abcd: {},
		ingangsklachten: {},
		triagecriteria: {},
	};
}

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

// --- 6. UNIVERSAL INTERACTION HANDLER (ALL FRAMES) ---

function handleInteraction(event) {
	if (!isTriageActive) return;

	const target = event.target;

	// Altered urgency score — U0-U5 radio buttons on the Adviezen step
	const urgencyBtn = target.closest("hc-horizontal-radio-button[formcontrolname='deviatedUrgency'] button");
	if (urgencyBtn) {
		const score = urgencyBtn.querySelector(".d-flex > span:last-child")?.textContent.trim();
		if (score) {
			window.top.postMessage({ type: "SET_META", payload: { field: "altered_urgency_score", value: score } }, "*");
		}
		return;
	}

	// Altered urgency reason — buttons inside hc-deviation-reason
	const reasonBtn = target.closest("hc-deviation-reason hc-horizontal-radio-button button");
	if (reasonBtn) {
		const reason = reasonBtn.querySelector(".d-flex")?.textContent.trim();
		if (reason) {
			window.top.postMessage({ type: "SET_META", payload: { field: "altered_urgency_reason", value: reason } }, "*");
		}
		return;
	}

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

function scanUrgencyScore() {
	// The HC-computed urgency is the indicator without a "huidige" chip.
	// When the triagist overrides, two indicators exist: one with chip (current/overridden)
	// and one without (original HC score). When no override, only one indicator exists.
	const indicators = document.querySelectorAll("hc-urgency-indicator");
	let score = null;

	for (const ind of indicators) {
		if (!ind.querySelector(".urgency-chip")) {
			score = ind.querySelector(".urgency-text")?.textContent.trim();
			if (score) break;
		}
	}

	// Fallback: no override present, single indicator is the HC score
	if (!score && indicators.length > 0) {
		score = indicators[0].querySelector(".urgency-text")?.textContent.trim();
	}

	if (score) {
		window.top.postMessage({ type: "SET_META", payload: { field: "urgency_score", value: score } }, "*");
	}
}

function scanTriageStepContainer(container) {
	if (!isTriageActive) return;

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
	if (!isTriageActive) return;

	for (const mutation of mutations) {
		for (const node of mutation.addedNodes) {
			if (node.nodeType !== Node.ELEMENT_NODE) continue;

			// Pre-populated triage criteria values
			const stepContainer = node.matches?.("hc-triage-step-container")
				? node
				: node.querySelector?.("hc-triage-step-container");
			if (stepContainer) scanTriageStepContainer(stepContainer);

			// Adviezen step loaded — scan for HC-computed urgency score
			const adviceContainer = node.matches?.("hc-advice-container")
				? node
				: node.querySelector?.("hc-advice-container");
			if (adviceContainer) scanUrgencyScore();

			// Patient tab loaded — extract last 5 digits of phone number as call ID
			const phoneInput = node.matches?.("input[data-qa='triage.contact.form.phonenumber']")
				? node
				: node.querySelector?.("input[data-qa='triage.contact.form.phonenumber']");
			if (phoneInput) {
				// Angular populates disabled form values after the render cycle
				if (!extractPhoneCallId()) {
					setTimeout(() => extractPhoneCallId() || setTimeout(extractPhoneCallId, 300), 0);
				}
			}
		}
	}
}).observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener("input", (event) => {
	if (!isTriageActive) return;
	if (event.target.matches("input[data-qa='triage.contact.form.phonenumber']")) {
		extractPhoneCallId(event.target);
	}
}, { capture: true });

document.addEventListener("change", (event) => {
	if (!isTriageActive) return;

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
		if (!data) return;

		if (data.type === "TRACK_CLICK") {
			updateAbcdState(data.payload);
			callWebhook(buildAggregatedJson());
		} else if (data.type === "SET_META") {
			abcdState.meta[data.payload.field] = data.payload.value;
			abcdState.meta.updated_at = nowAmsterdamISO();
			callWebhook(buildAggregatedJson());
		}
	});

	// --- DEBUG INDICATOR (remove before production) ---
	(function createDebugIndicator() {
		const indicator = document.createElement("div");
		indicator.id = "smartai-debug";
		Object.assign(indicator.style, {
			position: "fixed",
			bottom: "8px",
			right: "8px",
			padding: "2px 6px",
			backgroundColor: "rgba(0,0,0,0.5)",
			color: "#aaa",
			fontSize: "11px",
			fontFamily: "monospace",
			borderRadius: "3px",
			zIndex: "999999",
			pointerEvents: "none",
		});
		indicator.textContent = "SmartAI";
		document.body.appendChild(indicator);

		window.addEventListener("smartai:triage-started", () => {
			indicator.textContent = "SmartAI ✓";
			indicator.style.color = "#4caf50";
		});
	})();

	// TODO: Replace this click-based trigger with the HealthConnected triage-start event
	// once their API provides it. Swap the delegated click listener below for:
	//   window.addEventListener("healthconnected:triage-start", (e) => { ... })
	// The event is expected to carry a call_id — assign it to CALL_ID at that point.
	document.addEventListener("click", (event) => {
		if (!event.target.closest("[data-qa='menu.triage-start']")) return;
		resetState();
		isTriageActive = true;
		window.dispatchEvent(new Event("smartai:triage-started"));
	}, { capture: true });
}
