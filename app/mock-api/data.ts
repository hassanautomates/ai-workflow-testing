// Fixed, made-up data. Nothing here may depend on time, randomness or request
// order: the harness replays fetches against this API and must get the same
// answer the engine got.

export interface Order {
  id: string;
  item: string;
  amount: number;
}

export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  tier: 'gold' | 'silver' | 'bronze';
  since: string;
  address: { city: string; country: string };
  orders: Order[];
}

export const customers: readonly Customer[] = [
  {
    id: 'C-1001',
    firstName: 'Mira',
    lastName: 'Okafor',
    email: 'Mira.Okafor@Example.com',
    tier: 'gold',
    since: '2019-04-12',
    address: { city: 'Lisbon', country: 'PT' },
    orders: [
      { id: 'O-5001', item: 'Desk lamp', amount: 42.5 },
      { id: 'O-5002', item: 'Notebook set', amount: 18 },
      { id: 'O-5003', item: 'Monitor arm', amount: 129.99 },
    ],
  },
  {
    id: 'C-1002',
    firstName: 'Tomas',
    lastName: 'Lindqvist',
    email: 'TOMAS.L@example.com',
    tier: 'silver',
    since: '2021-09-30',
    address: { city: 'Uppsala', country: 'SE' },
    orders: [
      { id: 'O-5101', item: 'Headphones', amount: 89 },
      { id: 'O-5102', item: 'USB-C cable', amount: 9.5 },
    ],
  },
  {
    id: 'C-1003',
    firstName: 'Priya',
    lastName: 'Raman',
    email: 'priya.raman@example.com',
    tier: 'bronze',
    since: '2024-01-08',
    address: { city: 'Pune', country: 'IN' },
    orders: [],
  },
];

export const rates = {
  currency: 'USD',
  taxRates: { standard: 0.0825, reduced: 0.04, zero: 0 },
} as const;
