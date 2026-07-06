<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

// Eloquent model relying on convention (no $table): Laravel maps this to the
// snake_case plural of the class name — shipping_addresses.
class ShippingAddress extends Model
{
    protected $fillable = ['line1', 'city', 'postal_code'];
}
