# outlets-service

Express + TypeScript API for managing press outlets (publications) and their domain authority data.

## Setup

```bash
npm install
cp .env.example .env  # configure DATABASE_URL, PORT, API_KEY
npm run migrate       # create tables
npm run dev           # start dev server
```

## Scripts

- `npm run build` — compile TypeScript
- `npm run dev` — dev server with hot reload
- `npm test` — run tests
- `npm run migrate` — run database migrations
- `npm run generate-openapi` — regenerate openapi.json from Zod schemas

## API

See `openapi.json` or `GET /openapi.json` for the full spec.
