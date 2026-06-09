import { escapeAttr, escapeHtml } from "./utils.js";

// Markdown renderer initialization
export let markdownInitialized = false;

export function initializeMarkdownRenderer() {
	if (typeof marked === "undefined" || typeof DOMPurify === "undefined")
		return false;

	marked.setOptions({
		gfm: true,
		breaks: true,
		headerIds: false,
		highlight: (code, lang) => {
			if (typeof Prism !== "undefined" && Prism.languages[lang]) {
				return Prism.highlight(code, Prism.languages[lang], lang);
			}
			return code;
		},
	});

	// Custom code block renderer - preserves copy button structure
	marked.use({
		renderer: {
			code(code, lang) {
				const displayLang = lang || "code";
				const highlighted = this.options.highlight
					? this.options.highlight(code, lang)
					: escapeHtml(code);
				return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${escapeHtml(displayLang)}</span><button class="code-copy-btn" aria-label="Copy code">Copy</button></div><pre><code class="${lang || ""}">${highlighted}</code></pre></div>`;
			},
		},
	});

	markdownInitialized = true;
	return true;
}

/**
 * Linkify file paths in text
 * Detects common path patterns and wraps them in clickable links
 * Paths like /path/to/file, ./relative/path, ../parent/path, ~/home/path
 */
export function linkifyFilePaths(text) {
	if (!text) return "";

	// Pattern to match file paths:
	// - Absolute paths: /path/to/file
	// - Relative paths: ./path or ../path
	// - Home paths: ~/path
	// Excludes paths already in code blocks or URLs
	const pathPattern = /(^|\s)(~?\.?\.?\/[\w\-./~\\]+)/g;

	return text.replace(pathPattern, (_match, prefix, path) => {
		return `${prefix}<a class="file-link" href="#" data-path="${escapeAttr(path)}">${escapeHtml(path)}</a>`;
	});
}

export function formatMarkdown(text) {
	if (!text) return "";

	// Use Marked.js if available, fallback to regex
	if (
		markdownInitialized &&
		typeof marked !== "undefined" &&
		typeof DOMPurify !== "undefined"
	) {
		try {
			const html = marked.parse(text);
			return DOMPurify.sanitize(html, {
				ALLOWED_TAGS: [
					"h1",
					"h2",
					"h3",
					"h4",
					"h5",
					"h6",
					"p",
					"br",
					"strong",
					"em",
					"code",
					"pre",
					"a",
					"ul",
					"ol",
					"li",
					"blockquote",
					"table",
					"thead",
					"tbody",
					"tr",
					"th",
					"td",
					"hr",
					"del",
					"div",
					"span",
					"button",
				],
				ALLOWED_ATTR: ["href", "class", "aria-label", "target", "rel"],
				FORBID_TAGS: ["script", "iframe", "object", "embed", "style"],
				FORBID_ATTR: ["onclick", "onerror", "onload", "onmouseover"],
			});
		} catch (e) {
			console.error("[Markdown] Parse error, falling back to regex:", e);
			// Fall through to regex fallback
		}
	}

	// Fallback regex renderer (original implementation)
	let html = escapeHtml(text);

	const codeBlocks = [];
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
		const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
		codeBlocks.push({ lang, code });
		return placeholder;
	});

	const inlineCodes = [];
	html = html.replace(/`([^`]+)`/g, (_, code) => {
		const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
		inlineCodes.push(code);
		return placeholder;
	});

	html = linkifyFilePaths(html);

	html = html.replace(/__INLINE_CODE_(\d+)__/g, (_, idx) => {
		return `<code>${inlineCodes[idx]}</code>`;
	});

	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	html = html.replace(/\n/g, "<br>");

	html = html.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => {
		const block = codeBlocks[idx];
		const displayLang = block.lang || "code";
		return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${displayLang}</span><button class="code-copy-btn" aria-label="Copy code">Copy</button></div><pre><code class="${block.lang}">${block.code}</code></pre></div>`;
	});

	return html;
}
