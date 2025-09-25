# Intersophia FAQ

Static FAQ landing page for the Intersophia student society. The project is framework-free and uses a small amount of vanilla JavaScript to hydrate content from `assets/faq-data.json`.

## Project structure

- `index.html` – base markup for desktop and mobile layouts.
- `assets/css/styles.css` – consolidated theme, layout, and animation rules.
- `assets/js/main.js` – data loading, desktop question switcher, and mobile accordion logic.
- `assets/faq-data.json` – FAQ content organised into sections/items.

## Running locally

No build step is required. Open `index.html` directly in a browser or serve the folder with any static server:

```powershell
npx serve .
```

Then visit the URL printed in the terminal (default `http://localhost:3000`).

## Key UX details

- Desktop view keeps the logo and socials bar fixed while the answer card scrolls independently.
- Sidebar links update a single shared answer panel and preserve the current question in the URL hash.
- Mobile view swaps to an accordion with guided icon highlights and auto-scroll that respects `prefers-reduced-motion`.
- Custom dark theme tokens and branded scrollbars keep the experience consistent across layouts.

## Deployment

The site is designed to work on GitHub Pages. A published demo lives at <https://otisred.github.io/Intersophia/>.
