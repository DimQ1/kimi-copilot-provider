const CONTENT_LENGTH_HEADER = 'content-length';

export class ResponseBodyTooLargeError extends Error {
	constructor(
		readonly maxBytes: number,
		readonly actualBytes?: number,
	) {
		super(
			actualBytes === undefined
				? `Response body exceeded ${String(maxBytes)} bytes.`
				: `Response body is ${String(actualBytes)} bytes; limit is ${String(maxBytes)} bytes.`,
		);
		this.name = 'ResponseBodyTooLargeError';
	}
}

export async function readBoundedResponseText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const contentLength = Number(response.headers?.get(CONTENT_LENGTH_HEADER));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel();
		throw new ResponseBodyTooLargeError(maxBytes, contentLength);
	}

	if (!response.body) {
		const text = await response.text();
		const actualBytes = Buffer.byteLength(text, 'utf8');
		if (actualBytes > maxBytes) {
			throw new ResponseBodyTooLargeError(maxBytes, actualBytes);
		}
		return text;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new ResponseBodyTooLargeError(maxBytes, totalBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return Buffer.concat(chunks, totalBytes).toString('utf8');
}
