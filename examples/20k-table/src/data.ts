export type Status = "paid" | "pending" | "overdue";

export interface Row {
  id: number;
  name: string;
  company: string;
  city: string;
  status: Status;
  amount: number;
  date: string;
}

export type ColumnKey = keyof Row;

export interface Column {
  key: ColumnKey;
  label: string;
  width: number;
  numeric?: boolean;
}

export const COLUMNS: Column[] = [
  { key: "id", label: "#", width: 80, numeric: true },
  { key: "name", label: "Client", width: 200 },
  { key: "company", label: "Company", width: 200 },
  { key: "city", label: "City", width: 150 },
  { key: "status", label: "Status", width: 120 },
  { key: "amount", label: "Amount", width: 130, numeric: true },
  { key: "date", label: "Date", width: 120 },
];

const FIRST = ["Ana", "Bruno", "Camila", "Diego", "Elena", "Fabián", "Gabriela", "Héctor", "Inés", "Joaquín", "Lucía", "Martín", "Noelia", "Óscar", "Paula", "Ramiro", "Sofía", "Tomás", "Valeria", "Ximena"];
const LAST = ["Andrade", "Benítez", "Cárdenas", "Delgado", "Espinoza", "Figueroa", "Guzmán", "Herrera", "Ibarra", "Jiménez", "León", "Mendoza", "Navarro", "Ortega", "Paredes", "Quintero", "Ríos", "Salazar", "Torres", "Zambrano"];
const COMPANY = ["Andes Logística", "Bahía Software", "Cóndor Foods", "Delta Seguros", "Estrella Textil", "Faro Energía", "Galápagos Tours", "Horizonte Media", "Inca Minería", "Jade Farma", "Kuna Café", "Lumbre Diseño"];
const CITY = ["Quito", "Guayaquil", "Cuenca", "Lima", "Bogotá", "Medellín", "Santiago", "Montevideo", "Buenos Aires", "Mexico City", "Madrid", "La Paz"];
const STATUS: Status[] = ["paid", "pending", "overdue"];

const DAY_MS = 86_400_000;

/** Mulberry32: a tiny seeded PRNG, so the same seed always gives the same rows. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same rows every time for a given seed, so perf runs compare like with like. */
export function makeRows(count: number, seed = 42): Row[] {
  const random = seededRandom(seed);
  const pick = <T,>(options: T[]) => options[Math.floor(random() * options.length)];
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(2025, 0, 1) + Math.floor(random() * 600) * DAY_MS);
    rows.push({
      id: i + 1,
      name: `${pick(FIRST)} ${pick(LAST)}`,
      company: pick(COMPANY),
      city: pick(CITY),
      status: pick(STATUS),
      amount: Math.round(random() * 5_000_000) / 100,
      date: date.toISOString().slice(0, 10),
    });
  }
  return rows;
}
