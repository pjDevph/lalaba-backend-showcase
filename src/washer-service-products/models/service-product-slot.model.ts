import { ObjectType, Field } from '@nestjs/graphql';
import { InventoryCategory } from '../../inventory/schemas/inventory.schema';
import { Product } from '../../products/schemas/product.schema';

// One customer-facing "slot" for a given service: the free default product
// plus whichever other active products in the same category the customer
// could pay to swap in instead.
@ObjectType()
export class ServiceProductSlot {
  @Field(() => InventoryCategory)
  category!: InventoryCategory;

  @Field(() => Product)
  defaultProduct!: Product;

  @Field(() => [Product])
  alternativeProducts!: Product[];
}
