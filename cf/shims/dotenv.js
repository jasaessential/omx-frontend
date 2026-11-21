/* OMX — Workers get their settings from wrangler vars/secrets, not .env */
export function config() { return { parsed: {} }; }
export default { config };
