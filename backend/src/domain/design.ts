/**
 * Stored parameters for a generated stone.
 *
 * Only parameters are persisted, never mesh geometry. A design is therefore a
 * few hundred bytes, and the client regenerates the mesh deterministically from
 * the seed — which is also what makes a shared link reproduce exactly what the
 * author saw.
 *
 * The frontend mirrors these types in `src/features/studio/types.ts`. This copy
 * is the authoritative one: the client's validation is for fast feedback only.
 */
import { z } from 'zod';

const unitInterval = z.number().finite().min(0).max(1);
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour such as #8a8577');

export const designParamsSchema = z
  .object({
    /**
     * Drives every pseudo-random decision in the generator. Derived from the
     * chosen coordinates so the same place always yields the same stone.
     */
    seed: z.string().min(1).max(64),

    /** Exact target bounding box. The generator scales its output to match. */
    dimensions: z
      .object({
        length_mm: z.number().finite().min(1).max(10_000),
        width_mm: z.number().finite().min(1).max(10_000),
        height_mm: z.number().finite().min(1).max(10_000),
      })
      .strict(),

    form: z
      .object({
        roundness: unitInterval,
        taper: z.number().finite().min(-1).max(1),
        asymmetry: unitInterval,
        flatten: unitInterval,
        bulge: unitInterval,
      })
      .strict(),

    surface: z
      .object({
        detail: unitInterval,
        grain: unitInterval,
        erosion: unitInterval,
        faceting: unitInterval,
        /**
         * Icosphere subdivision level. Level 5 is ~20k triangles, level 6 is
         * ~82k. Capped at 6 to match the editor: level 7 produces a mesh large
         * enough to stall a phone during export.
         */
        resolution: z.number().int().min(2).max(6),
      })
      .strict(),

    material: z
      .object({
        color: hexColor,
        accentColor: hexColor,
        roughness: unitInterval,
        metalness: unitInterval,
        speckle: unitInterval,
        clearcoat: unitInterval,
      })
      .strict(),
  })
  .strict();

export type DesignParams = z.infer<typeof designParamsSchema>;

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Give the design a name.')
  .max(80, 'Keep the name under 80 characters.');

export const createDesignSchema = z
  .object({
    name: nameSchema,
    params: designParamsSchema,
    latitude: z.number().finite().min(-90).max(90).nullish(),
    longitude: z.number().finite().min(-180).max(180).nullish(),
    place_label: z.string().trim().max(200).nullish(),
  })
  .strict();

export const updateDesignSchema = createDesignSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Nothing to update.' },
);

export type CreateDesignInput = z.infer<typeof createDesignSchema>;
export type UpdateDesignInput = z.infer<typeof updateDesignSchema>;
