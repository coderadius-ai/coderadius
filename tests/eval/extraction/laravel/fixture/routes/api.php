<?php

use App\Http\Controllers\InventoryController;
use App\Http\Controllers\OrderController;
use Illuminate\Support\Facades\Route;

// Explicit verb routes — Route::get/post('/path', [Controller::class, 'method']).
Route::get('/orders/{id}', [OrderController::class, 'show']);
Route::post('/orders', [OrderController::class, 'store']);

// Resource controller — Route::apiResource expands to the 5-endpoint REST
// surface (index, store, show, update, destroy); no create/edit HTML views.
Route::apiResource('inventory', InventoryController::class);
