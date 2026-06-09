import path from "path";
import logger from "./logger.js";

/**
 * Process uploaded file and extract content
 */
export async function processUpload(file) {
	const ext = path.extname(file.originalname).toLowerCase();

	if (ext === ".pdf") {
		return await extractPdfText(file.buffer);
	}

	if ([".txt", ".md"].includes(ext)) {
		return {
			content: file.buffer.toString("utf8"),
			type: ext === ".md" ? "markdown" : "text",
		};
	}

	throw new Error(`Unsupported file type: ${ext}`);
}

/**
 * Extract text from PDF buffer
 */
async function extractPdfText(buffer) {
	try {
		// Dynamic import for pdf-parse
		const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
		const data = await pdfParse(buffer);
		return {
			content: data.text,
			type: "pdf",
			pages: data.numpages,
		};
	} catch (err) {
		logger.error("[Upload] PDF extraction error:", err);
		throw new Error("Failed to extract PDF content");
	}
}

/**
 * Validate file size and type
 */
export function validateFile(file) {
	const maxSize = 10 * 1024 * 1024; // 10MB
	const allowedExtensions = [".txt", ".md", ".pdf"];

	if (file.size > maxSize) {
		throw new Error("File too large (max 10MB)");
	}

	const ext = path.extname(file.originalname).toLowerCase();
	if (!allowedExtensions.includes(ext)) {
		throw new Error(`Unsupported file type: ${ext}`);
	}

	return true;
}
