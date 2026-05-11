// ================================
// content.js — TARGET SPECIFIC ROW (LI)
// ================================

// --- 1. GLOBAL VARIABLES ---
const IS_TOP = window === window.top;
let TOPICUS_ID = null;

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

	abcdState[category][key] = {
		text: value,
		timestamp: nowAmsterdamISO(),
	};

	abcdState.meta.updated_at = nowAmsterdamISO();
}

function buildAggregatedJson() {
	return {
		topicus_id: TOPICUS_ID,
		gp_name: GP_CONFIG.name,
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

// --- 6. UNIVERSAL INTERACTION HANDLER (ALL FRAMES) ---

function handleInteraction(event) {
	const target = event.target;

	// --- A. BUTTON CLICKS (ABCD or Triagecriteria) ---
	const button = target.closest("button.btn"); // slightly broader to catch all buttons
	if (button) {
		const value = button.textContent.trim();

		// 1. Detect if it's an ABCD question
		const abcdContainer = button.closest(".form-section.abcd-vragen");
		if (abcdContainer) {
			const question = button.closest(".question.abcd-vraag");

			// --- A. Main Header (e.g., "Circulation") ---
			let sectionLabel = "unknown";
			const mainLabelEl = question?.querySelector(":scope > label");
			if (mainLabelEl) {
				// Get only direct text (ignores tooltips inside the label)
				sectionLabel =
					Array.from(mainLabelEl.childNodes)
						.filter((n) => n.nodeType === Node.TEXT_NODE)
						.map((n) => n.textContent.trim())
						.join(" ")
						.trim() || sectionLabel;
			}

			// --- B. Sub-Label (e.g., "Kleur") ---
			// LOGIC: The HTML shows each row is an <li>. We find the specific <li>
			// the button belongs to, then find the .criteria-label inside THAT <li>.
			let subLabel = "";
			const rowItem = button.closest("li");

			if (rowItem) {
				// Try finding the exact class from your HTML
				const labelSpan = rowItem.querySelector(".criteria-label");
				if (labelSpan) {
					subLabel = labelSpan.textContent.trim();
				}
				// Fallback: if .criteria-label class is missing, try .control-label
				else {
					const altLabel = rowItem.querySelector(".control-label");
					if (altLabel) subLabel = altLabel.textContent.trim();
				}
			}

			// Clean up subLabel (remove colons)
			subLabel = subLabel.replace(/:/g, "").trim();

			// Create Unique Key: "Circulation: Kleur"
			const uniqueLabel = subLabel
				? `${sectionLabel}: ${subLabel}`
				: sectionLabel;

			window.top.postMessage(
				{
					type: "TRACK_CLICK",
					payload: { category: "abcd", label: uniqueLabel, value },
				},
				"*"
			);
			return;
		}

		// 2. Detect if it's a Triagecriteria question
		// These are also often in <li> tags, so we can reuse similar logic or keep strictly separate
		const criteriaLi = button.closest("ul.triagecriteria li");
		if (criteriaLi && !button.closest(".abcd-vragen")) {
			// (The !check above ensures we don't double-count ABCD as triagecriteria)
			const label =
				criteriaLi.querySelector(".criteria-label")?.textContent.trim() ||
				"unknown";
			window.top.postMessage(
				{
					type: "TRACK_CLICK",
					payload: { category: "triagecriteria", label, value },
				},
				"*"
			);
			return;
		}
	}

	// --- B. COMPLAINT CLICKS ---
	const complaintLabel = target.closest("label.omschrijving");
	const complaintCheckbox = target.closest("input.ingangsklacht-selectbox");

	if (complaintLabel || complaintCheckbox) {
		let labelText = "";
		if (complaintLabel) {
			labelText = complaintLabel.textContent.trim();
		} else if (complaintCheckbox) {
			const id = complaintCheckbox.id;
			const label = document.querySelector(`label[for="${id}"]`);
			labelText = label ? label.textContent.trim() : "unknown";
		}

		if (labelText) {
			window.top.postMessage(
				{
					type: "TRACK_CLICK",
					payload: {
						category: "ingangsklachten",
						label: labelText,
						value: "selected",
					},
				},
				"*"
			);
		}
	}
}

document.addEventListener("click", handleInteraction, {
	capture: true,
	passive: true,
});

// --- 7. TOP FRAME INITIALIZATION ---

if (IS_TOP) {
	const urlParts = window.location.pathname.split("/").filter(Boolean);
	TOPICUS_ID = urlParts.pop();

	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || data.type !== "TRACK_CLICK") return;

		updateAbcdState(data.payload);
		callWebhook(buildAggregatedJson());
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
