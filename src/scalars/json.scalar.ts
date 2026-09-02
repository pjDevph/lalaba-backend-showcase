import { Scalar, CustomScalar } from '@nestjs/graphql';
import { Kind, ValueNode } from 'graphql';

@Scalar('JSON', () => Object)
export class JSONScalar implements CustomScalar<any, any> {
  description = 'JSON custom scalar type';

  parseValue(value: any): any {
    return value;
  }

  serialize(value: any): any {
    return value;
  }

  parseLiteral(ast: ValueNode): any {
    switch (ast.kind) {
      case Kind.STRING:
        return ast.value;
      case Kind.INT:
        return parseInt(ast.value, 10);
      case Kind.FLOAT:
        return parseFloat(ast.value);
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.NULL:
        return null;
      case Kind.OBJECT: {
        const obj: Record<string, any> = {};
        ast.fields.forEach((field) => {
          obj[field.name.value] = this.parseLiteral(field.value);
        });
        return obj;
      }
      case Kind.LIST:
        return ast.values.map((v) => this.parseLiteral(v));
      default:
        return null;
    }
  }
}
