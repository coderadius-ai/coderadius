<?php

namespace App\Http\Controllers;

// Sink-free controller: methods return plain arrays so routing extraction
// stays deterministic and LLM-free (no I/O signal for the heuristic gate).
class PaymentController extends Controller
{
    public function store(): array
    {
        return ['id' => 'pay_1', 'status' => 'authorized'];
    }

    public function show(string $id): array
    {
        return ['id' => $id, 'status' => 'authorized'];
    }

    public function update(string $id): array
    {
        return ['id' => $id, 'updated' => true];
    }

    public function destroy(string $id): array
    {
        return ['id' => $id, 'voided' => true];
    }

    public function capture(string $id): array
    {
        return ['id' => $id, 'status' => 'captured'];
    }
}
