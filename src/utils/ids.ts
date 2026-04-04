import { nanoid } from "nanoid";

export function newSessionId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${nanoid(8)}`;
}

export function newCorrelationId(): string {
	return nanoid(12);
}
