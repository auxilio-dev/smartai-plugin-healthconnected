// phone-reader.js — runs in MAIN world (can access Angular internals)
// Communicates with content.js (isolated world) via window.postMessage

let active = false;

window.addEventListener("message", (e) => {
	if (e.data?.type === "__SMARTAI_TRIAGE_START__") {
		active = true;
		tryExtractNow();
	}
});

function tryExtractNow() {
	if (!active) return;

	// Strategy 1: native el.value (works if Angular wrote via DefaultValueAccessor)
	for (const el of document.querySelectorAll("hc-phone-number input, input[data-qa='triage.contact.form.phonenumber']")) {
		const digits = el.value.replace(/\D/g, "");
		if (digits.length >= 5) { reportPhone(digits.slice(-5)); return; }
	}

	// Strategy 2: Angular form control via ng.getComponent (available in dev builds)
	tryAngularFormControl();
}

function tryAngularFormControl() {
	try {
		const host = document.querySelector("hc-contact-info-form");
		if (!host || !window.ng) return;
		const comp = window.ng.getComponent(host);
		if (!comp) return;
		const form = comp.form || comp.contactForm || comp.formGroup;
		if (!form) return;
		const groups = form.get("phoneNumbers")?.controls || [];
		for (const group of groups) {
			const num = group.get("number")?.value;
			if (num) {
				const digits = String(num).replace(/\D/g, "");
				if (digits.length >= 5) { reportPhone(digits.slice(-5)); return; }
			}
		}
	} catch (e) {
		console.log("[SmartAI main] ng.getComponent failed:", e.message);
	}
}

// Intercept value setter on a specific input instance so we catch Angular's write
function interceptInput(inputEl) {
	if (inputEl.__smartaiWatched) return;
	inputEl.__smartaiWatched = true;

	const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	Object.defineProperty(inputEl, "value", {
		get() { return descriptor.get.call(this); },
		set(v) {
			descriptor.set.call(this, v);
			if (active && typeof v === "string") {
				const digits = v.replace(/\D/g, "");
				if (digits.length >= 5) reportPhone(digits.slice(-5));
			}
		},
		configurable: true,
	});

	// Also read whatever value is already there
	const digits = descriptor.get.call(inputEl).replace(/\D/g, "");
	if (active && digits.length >= 5) reportPhone(digits.slice(-5));
}

// Watch for phone inputs being added to the DOM
new MutationObserver((mutations) => {
	for (const mutation of mutations) {
		for (const node of mutation.addedNodes) {
			if (node.nodeType !== Node.ELEMENT_NODE) continue;

			const inputs = node.matches?.("input") && node.closest?.("hc-phone-number")
				? [node]
				: [...(node.querySelectorAll?.("hc-phone-number input, input[data-qa='triage.contact.form.phonenumber']") || [])];

			for (const input of inputs) {
				interceptInput(input);
				if (active) tryAngularFormControl();
			}
		}
	}
}).observe(document.documentElement, { childList: true, subtree: true });

// Also intercept any phone inputs already in the DOM when triage starts
function interceptExisting() {
	for (const el of document.querySelectorAll("hc-phone-number input, input[data-qa='triage.contact.form.phonenumber']")) {
		interceptInput(el);
	}
}

window.addEventListener("message", (e) => {
	if (e.data?.type === "__SMARTAI_TRIAGE_START__") interceptExisting();
});

function reportPhone(last5) {
	console.log("[SmartAI main] phone captured:", last5);
	window.postMessage({ type: "__SMARTAI_PHONE__", value: last5 }, "*");
}
