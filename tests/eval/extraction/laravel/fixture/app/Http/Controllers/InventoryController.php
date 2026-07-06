<?php

namespace App\Http\Controllers;

// Resource controller backing Route::apiResource('inventory', ...).
// Sink-free: every action returns a plain array (no DB / no I/O).
class InventoryController extends Controller
{
    public function index(): array
    {
        return [];
    }

    public function store(): array
    {
        return ['id' => 'inv_1', 'sku' => 'SKU-1'];
    }

    public function show(string $id): array
    {
        return ['id' => $id, 'sku' => 'SKU-1'];
    }

    public function update(string $id): array
    {
        return ['id' => $id, 'updated' => true];
    }

    public function destroy(string $id): array
    {
        return ['id' => $id, 'deleted' => true];
    }
}
