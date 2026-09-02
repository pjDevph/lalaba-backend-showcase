import { InputType, PartialType } from '@nestjs/graphql';
import { CreateAddressInput } from './create-address.input';

// A partial update replaces whichever whole sub-object you provide (e.g. pass
// the full `address` block if you're correcting the street, not just one
// field within it) — simpler and less error-prone than deep field-level
// patching for a PSGC-structured address.
// Explicit GraphQL name to avoid colliding with the update-user UpdateAddressInput.
@InputType('UpdateCustomerAddressInput')
export class UpdateAddressInput extends PartialType(CreateAddressInput) {}
