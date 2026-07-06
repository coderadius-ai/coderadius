<?php

namespace App\Http\Controllers;

// Sink-free controller: methods return plain arrays so routing extraction
// stays deterministic and LLM-free (no I/O signal for the heuristic gate).
class OrderController extends Controller
{
    public function show(string $id): array
    {
        return ['id' => $id, 'status' => 'pending'];
    }

    public function store(): array
    {
        return ['id' => 'ord_1', 'status' => 'created'];
    }
}
