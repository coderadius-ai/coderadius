<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

// Eloquent model with an explicit table name.
class Order extends Model
{
    protected $table = 'orders';

    protected $fillable = ['reference', 'total_amount', 'status'];
}
