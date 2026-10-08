/**
 * @description delay function
 * @param {any} milliseconds
 * @returns {Promise<any>}
 */
export function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
/**
 * @description retryAfterMilliseconds function
 * @param {any} response
 * @param {any} body
 * @returns {number}
 */
export function retryAfterMilliseconds(response, body) {
    const header = response.headers.get('retry-after');
    if (header !== null) {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0)
            return seconds * 1000;
        const date = Date.parse(header);
        if (Number.isFinite(date))
            return Math.max(0, date - Date.now());
    }
    const bodySeconds = Number(body?.retry_after);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0)
        return bodySeconds * 1000;
    return null;
}
/**
 * @description parseResponseBody function
 * @param {any} text
 * @param {any} contentType
 * @returns {any}
 */
export function parseResponseBody(text, contentType) {
    if (!text)
        return null;
    if (contentType.includes('json')) {
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    return text;
}
export default { delay, retryAfterMilliseconds, parseResponseBody };