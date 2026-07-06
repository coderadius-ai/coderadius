<?php

use App\Http\Controllers\PaymentController;
use App\Http\Controllers\ShipmentController;
use Illuminate\Support\Facades\Route;

// Distinct verb mix from the primary fixture: post/get/put/delete plus a
// nested-path patch route — generalization across the direct-method branch.
Route::post('/payments', [PaymentController::class, 'store']);
Route::get('/payments/{id}', [PaymentController::class, 'show']);
Route::put('/payments/{id}', [PaymentController::class, 'update']);
Route::delete('/payments/{id}', [PaymentController::class, 'destroy']);
Route::patch('/payments/{id}/capture', [PaymentController::class, 'capture']);

// Resource controller — 5-endpoint REST surface for shipments.
Route::apiResource('shipments', ShipmentController::class);
