export function releaseAssetUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port || url.username || url.password || url.search || url.hash ||
        !/^\/repos\/bentbrain\/bent-mono\/releases\/assets\/[1-9][0-9]+$/.test(url.pathname))
        throw new Error("An exact repository release asset URL is required.");
    return url.href;
}
