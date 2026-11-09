/** Where the app under test listens. Shared by playwright.config.ts and specs that fetch at load time. */
export const port = Number(process.env.PORT ?? 3000);
export const baseURL = `http://localhost:${String(port)}`;
