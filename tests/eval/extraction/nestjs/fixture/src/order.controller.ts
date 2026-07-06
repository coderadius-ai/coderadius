import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';

// Idiomatic NestJS: a class-level @Controller prefix composed with method-level
// HTTP-verb decorators. The framework exposes the JOINED path
// (prefix + method route), e.g. @Controller('orders') + @Get(':id') → GET /orders/{id}.
//
// Handlers are intentionally SINK-FREE (return a literal) so extraction is
// driven purely by the decorator route grammar, not by body I/O.
@Controller('orders')
export class OrderController {
    @Get(':id')
    findOne(@Param('id') id: string): string {
        return id;
    }

    @Post()
    create(@Body() body: unknown): string {
        return 'created';
    }

    @Delete(':id')
    remove(@Param('id') id: string): string {
        return 'removed';
    }
}
