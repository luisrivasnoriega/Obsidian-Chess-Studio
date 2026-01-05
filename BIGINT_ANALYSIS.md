# Análisis del Error de Serialización BigInt

## Problema

Al usar "build variants", se produce el error: **"do not know how to serialize a BigInt"**

## Análisis del Flujo

### 1. Frontend (TypeScript)

**Ubicación**: `src/features/boards/components/BoardVariants.tsx`

**Función**: `pickEngineMoveUci` (líneas 998-1064)

**Llamadas a `upsertVariantPosition`**:
- Línea 1029: `await runExclusive(() => upsertVariantPosition(trimmedFen, engineKey, cachedMove, cachedMs));`
  - `cachedMs` es un `number` (viene de `getVariantPosition`)
- Línea 1059: `await runExclusive(() => upsertVariantPosition(trimmedFen, key, primary, requestedMs));`
  - `requestedMs` es un `number` (viene de `treeBuilderEngineMs` state)

### 2. Wrapper TypeScript

**Ubicación**: `src/utils/variantPositions.ts`

**Función**: `upsertVariantPosition`
- Recibe: `ms: number`
- Llama: `invoke("upsert_variant_position", { ..., ms: ms })`
- **Solución actual**: Pasa `number` directamente, no `BigInt`

### 3. Binding Generado

**Ubicación**: `src/bindings/generated.ts`

**Línea 679**: 
```typescript
async upsertVariantPosition(..., ms: bigint) : Promise<Result<null, string>>
```

**Problema**: El binding generado por `tauri-specta` espera `bigint`, pero:
- Tauri no puede serializar `BigInt` a JSON directamente
- Si pasamos `BigInt`, falla la serialización
- Si pasamos `number`, Tauri debería convertirlo automáticamente a `i64`

### 4. Backend (Rust)

**Ubicación**: `src-tauri/src/variant_positions.rs`

**Línea 194**: 
```rust
pub fn upsert_variant_position(..., ms: i64) -> Result<()>
```

**Tipo esperado**: `i64` (entero de 64 bits con signo)

## Solución Implementada

### Frontend (`variantPositions.ts`)

```typescript
export async function upsertVariantPosition(
  fen: string,
  engine: string,
  recommended_move: string,
  ms: number,  // Recibe number
): Promise<void> {
  await invoke("upsert_variant_position", {
    fen,
    engine,
    recommendedMove: recommended_move,
    ms: ms,  // Pasa number directamente, Tauri lo convierte a i64
  });
}
```

**Por qué funciona**:
- Usamos `invoke` directamente en lugar del binding generado
- Pasamos `number` en lugar de `BigInt`
- Tauri convierte automáticamente `number` de JavaScript a `i64` de Rust
- Evitamos el error de serialización de BigInt a JSON

### Manejo de Respuestas (`getVariantPosition`)

```typescript
export async function getVariantPosition(...): Promise<VariantPosition | null> {
  const result = await invoke<any>("get_variant_position", { fen, engine });
  // Maneja múltiples formatos de BigInt que Tauri puede devolver
  let ms: number;
  if (typeof result.ms === "bigint") {
    ms = Number(result.ms);
  } else if (typeof result.ms === "string") {
    ms = Number.parseInt(result.ms, 10);
  } else if (typeof result.ms === "number") {
    ms = result.ms;
  } else if (result.ms && typeof result.ms === "object" && "value" in result.ms) {
    const value = result.ms.value;
    ms = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  } else {
    ms = 0;
  }
  return { ..., ms };
}
```

## Tests

### Tests TypeScript
**Ubicación**: `src/utils/__tests__/variantPositions.test.ts`
- ✅ 11 tests pasando
- Cubre todos los escenarios de uso
- Verifica que se pasa `number`, no `BigInt`

### Tests Rust
**Ubicación**: `src-tauri/src/variant_positions.rs`
- ✅ 6 tests pasando
- Verifica serialización/deserialización
- Verifica manejo de valores grandes y negativos

## Verificación

Para verificar que la solución funciona:

1. **Ejecutar tests TypeScript**:
   ```bash
   pnpm test variantPositions
   ```

2. **Ejecutar tests Rust**:
   ```bash
   cd src-tauri
   cargo test variant_positions
   ```

3. **Probar en la aplicación**:
   - Abrir "build variants"
   - Configurar profundidad y motor
   - Ejecutar "build variants"
   - No debería aparecer el error de serialización BigInt

## Notas Técnicas

- **Tauri v2**: Maneja automáticamente la conversión de `number` (JavaScript) a `i64` (Rust)
- **tauri-specta**: Genera bindings con tipo `bigint` para `i64`, pero esto es solo para tipos TypeScript
- **Serialización JSON**: BigInt no es parte del estándar JSON, por eso falla si intentamos serializarlo directamente
- **Solución**: Usar `number` en tiempo de ejecución, aunque el tipo TypeScript sea `bigint`

## Conclusión

El problema estaba en que el binding generado espera `bigint`, pero al usar `invoke` directamente y pasar `number`, Tauri maneja la conversión automáticamente sin problemas de serialización.

