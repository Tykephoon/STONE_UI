/**
 * Real-world objects for scale comparison.
 *
 * Numbers are hard to picture. "220 × 160 × 120 mm" means little until it sits
 * next to a drinks can. Every dimension below is a real published measurement,
 * cited in the comment beside it, because a scale reference that is merely
 * approximate is worse than none — it teaches the wrong size confidently.
 *
 * Shapes are deliberately primitive. A recognisable silhouette at the right
 * dimensions does the job; a detailed model would cost bundle size and
 * attention for no extra information.
 */

export type ReferenceShape = 'box' | 'cylinder' | 'sphere' | 'capsule';

export interface ReferenceObject {
  id: string;
  name: string;
  category: 'Everyday' | 'Coins' | 'Sport' | 'Building' | 'Body';
  shape: ReferenceShape;
  /** Millimetres. For cylinders and spheres, `length` is the diameter. */
  length: number;
  width: number;
  height: number;
  color: string;
  /** Where the figure comes from, shown in the UI as a tooltip. */
  source: string;
}

export const REFERENCE_OBJECTS: ReferenceObject[] = [
  // ---- Coins -------------------------------------------------------------
  {
    id: 'quarter',
    name: 'US quarter',
    category: 'Coins',
    shape: 'cylinder',
    length: 24.26,
    width: 24.26,
    height: 1.75,
    color: '#9a9488',
    source: 'US Mint: 24.26 mm diameter, 1.75 mm thick',
  },
  {
    id: 'penny',
    name: 'US penny',
    category: 'Coins',
    shape: 'cylinder',
    length: 19.05,
    width: 19.05,
    height: 1.52,
    color: '#a86b43',
    source: 'US Mint: 19.05 mm diameter, 1.52 mm thick',
  },
  {
    id: 'pound',
    name: 'UK £1',
    category: 'Coins',
    shape: 'cylinder',
    length: 23.43,
    width: 23.43,
    height: 2.8,
    color: '#b5975a',
    source: 'Royal Mint: 23.43 mm across flats, 2.8 mm thick',
  },

  // ---- Everyday ----------------------------------------------------------
  {
    id: 'credit-card',
    name: 'Bank card',
    category: 'Everyday',
    shape: 'box',
    length: 85.6,
    width: 53.98,
    height: 0.76,
    color: '#3987e5',
    source: 'ISO/IEC 7810 ID-1: 85.60 × 53.98 × 0.76 mm',
  },
  {
    id: 'aa-battery',
    name: 'AA battery',
    category: 'Everyday',
    shape: 'cylinder',
    length: 14.5,
    width: 14.5,
    height: 50.5,
    color: '#c98500',
    source: 'IEC LR6: 14.5 mm diameter, 50.5 mm tall',
  },
  {
    id: 'soda-can',
    name: 'Drinks can (330 ml)',
    category: 'Everyday',
    shape: 'cylinder',
    length: 66,
    width: 66,
    height: 115,
    color: '#d55181',
    source: 'Standard 330 ml can: 66 mm diameter, 115 mm tall',
  },
  {
    id: 'smartphone',
    name: 'Smartphone',
    category: 'Everyday',
    shape: 'box',
    length: 147,
    width: 71.5,
    height: 7.8,
    color: '#5a6070',
    source: 'Typical 6.1-inch handset: 147 × 71.5 × 7.8 mm',
  },
  {
    id: 'mug',
    name: 'Coffee mug',
    category: 'Everyday',
    shape: 'cylinder',
    length: 82,
    width: 82,
    height: 95,
    color: '#8a8577',
    source: 'Typical 350 ml mug: 82 mm diameter, 95 mm tall',
  },
  {
    id: 'ruler',
    name: '30 cm ruler',
    category: 'Everyday',
    shape: 'box',
    length: 310,
    width: 35,
    height: 3,
    color: '#c9c3b6',
    source: 'Standard 300 mm ruler, 310 mm overall',
  },

  // ---- Sport -------------------------------------------------------------
  {
    id: 'tennis-ball',
    name: 'Tennis ball',
    category: 'Sport',
    shape: 'sphere',
    length: 67,
    width: 67,
    height: 67,
    color: '#c98500',
    source: 'ITF: 65.41–68.58 mm diameter; 67 mm used here',
  },
  {
    id: 'baseball',
    name: 'Baseball',
    category: 'Sport',
    shape: 'sphere',
    length: 74,
    width: 74,
    height: 74,
    color: '#e8e4dc',
    source: 'MLB: 73–76 mm diameter; 74 mm used here',
  },
  {
    id: 'golf-ball',
    name: 'Golf ball',
    category: 'Sport',
    shape: 'sphere',
    length: 42.7,
    width: 42.7,
    height: 42.7,
    color: '#f0ece4',
    source: 'R&A/USGA minimum: 42.67 mm diameter',
  },
  {
    id: 'football',
    name: 'Football (size 5)',
    category: 'Sport',
    shape: 'sphere',
    length: 220,
    width: 220,
    height: 220,
    color: '#e8e4dc',
    source: 'FIFA size 5: 68–70 cm circumference, ≈220 mm diameter',
  },

  // ---- Building ----------------------------------------------------------
  {
    id: 'brick-uk',
    name: 'Brick (UK)',
    category: 'Building',
    shape: 'box',
    length: 215,
    width: 102.5,
    height: 65,
    color: '#a05a42',
    source: 'BS EN 771: 215 × 102.5 × 65 mm',
  },
  {
    id: 'brick-us',
    name: 'Brick (US modular)',
    category: 'Building',
    shape: 'box',
    length: 194,
    width: 92,
    height: 57,
    color: '#a05a42',
    source: 'US modular brick: 194 × 92 × 57 mm actual',
  },
  {
    id: 'paving-slab',
    name: 'Paving slab',
    category: 'Building',
    shape: 'box',
    length: 450,
    width: 450,
    height: 50,
    color: '#7a7a74',
    source: 'Common garden slab: 450 × 450 × 50 mm',
  },

  // ---- Body --------------------------------------------------------------
  {
    id: 'hand',
    name: 'Adult hand',
    category: 'Body',
    shape: 'box',
    length: 189,
    width: 84,
    height: 25,
    color: '#b08968',
    source: 'Adult male mean: 189 mm length, 84 mm breadth',
  },
  {
    id: 'thumb',
    name: 'Thumb',
    category: 'Body',
    shape: 'capsule',
    length: 20,
    width: 20,
    height: 60,
    color: '#b08968',
    source: 'Adult thumb: ≈60 mm long, ≈20 mm across',
  },
  {
    id: 'person',
    name: 'Person (1.7 m)',
    category: 'Body',
    shape: 'capsule',
    length: 400,
    width: 250,
    height: 1700,
    color: '#5a6070',
    source: 'Approximate adult height, 1700 mm',
  },
];

export const CATEGORIES = ['Everyday', 'Coins', 'Sport', 'Building', 'Body'] as const;

export function referenceById(id: string): ReferenceObject | undefined {
  return REFERENCE_OBJECTS.find((entry) => entry.id === id);
}

/** An object currently placed in the scene, with its position on the ground. */
export interface PlacedReference {
  /** Unique per placement, so the same object can be added twice. */
  instanceId: string;
  objectId: string;
  /** Millimetres from the origin, on the ground plane. */
  x: number;
  z: number;
}

/**
 * Pick a spot for a newly added object.
 *
 * Placed clear of the stone and of anything already there, so a new object
 * never lands hidden inside something else.
 */
export function suggestPlacement(
  existing: PlacedReference[],
  stoneLength: number,
  object: ReferenceObject,
): { x: number; z: number } {
  const clearance = stoneLength / 2 + object.length / 2 + 30;

  // Walk around the stone in 45° steps and take the first free slot.
  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 8) * Math.PI;
    const ring = 1 + Math.floor(step / 8);
    const x = Math.cos(angle) * clearance * ring;
    const z = Math.sin(angle) * clearance * ring;

    const clashes = existing.some((placed) => {
      const other = referenceById(placed.objectId);
      const minimum = ((other?.length ?? 50) + object.length) / 2 + 15;
      return Math.hypot(placed.x - x, placed.z - z) < minimum;
    });

    if (!clashes) return { x, z };
  }

  return { x: clearance, z: clearance };
}
