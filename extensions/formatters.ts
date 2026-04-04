/**
 * formatters.ts — Shared display helpers for Pi extensions
 *
 * Centralizes the small formatting functions that were duplicated across
 * minimal.ts, tool-counter.ts, agent-team.ts, agent-chain.ts, and pi-pi.ts.
 * Import from extensions that render footers, status lines, or widgets.
 *
 * Usage:
 *   import { contextBar, fmtPct, fmtCost, fmtElapsed } from "./formatters.ts";
 */

// ── Context bar ───────────────────────────────────────────────────────────────

/**
 * Render a block-fill context bar, e.g. `[###-------] 30%`
 *
 * @param pct    Usage percentage (0–100).
 * @param blocks Number of blocks in the bar (default 10).
 * @returns      Formatted string including surrounding brackets and percentage.
 */
export function contextBar(pct: number, blocks = 10): string {
	const filled = Math.max(0, Math.min(blocks, Math.round((pct / 100) * blocks)));
	const bar = "#".repeat(filled) + "-".repeat(blocks - filled);
	return `[${bar}] ${Math.round(pct)}%`;
}

// ── Percentage ────────────────────────────────────────────────────────────────

/**
 * Format a percentage to a rounded integer string with a `%` suffix.
 * @param pct   Value in percent (0–100+).
 */
export function fmtPct(pct: number): string {
	return `${Math.round(pct)}%`;
}

// ── Cost ─────────────────────────────────────────────────────────────────────

/**
 * Format a USD cost to a short dollar string, e.g. `$0.0042`.
 * @param usd  Cost in US dollars.
 */
export function fmtCost(usd: number): string {
	if (usd < 0.0001) return "$0.0000";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

// ── Elapsed time ──────────────────────────────────────────────────────────────

/**
 * Format elapsed milliseconds to a short human-readable string.
 * Examples: `0s`, `3s`, `1m23s`, `2h05m`
 * @param ms  Elapsed time in milliseconds.
 */
export function fmtElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}m${String(rem).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return `${h}h${String(remM).padStart(2, "0")}m`;
}

// ── Token counts ──────────────────────────────────────────────────────────────

/**
 * Format a token count with K abbreviation for readability.
 * Examples: `512`, `12.3K`, `1.2M`
 * @param n  Raw token count.
 */
export function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}
