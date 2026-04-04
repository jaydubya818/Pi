import fs from "fs-extra";

export async function appendJsonl(file: string, obj: unknown): Promise<void> {
	await fs.appendFile(file, `${JSON.stringify(obj)}\n`, "utf8");
}
