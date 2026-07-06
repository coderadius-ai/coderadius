<?php

namespace App\Http\Controllers;

// Resource controller backing Route::apiResource('shipments', ...).
// Sink-free: every action returns a plain array (no DB / no I/O).
class ShipmentController extends Controller
{
    public function index(): array
    {
        return [];
    }

    public function store(): array
    {
        return ['id' => 'shp_1', 'status' => 'label_created'];
    }

    public function show(string $id): array
    {
        return ['id' => $id, 'status' => 'in_transit'];
    }

    public function update(string $id): array
    {
        return ['id' => $id, 'updated' => true];
    }

    public function destroy(string $id): array
    {
        return ['id' => $id, 'cancelled' => true];
    }
}
