import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';

// Held-out generalization check — a DIFFERENT resource (notifications), a
// different param name (:key), a different verb mix (GET/POST/PATCH, no DELETE),
// a bare collection route (@Get() with no arg), and a param in the MIDDLE of a
// nested path (@Patch(':key/read') → /notifications/{key}/read).
//
// Grounded in what NestJS exposes after controller-prefix composition; proves
// the extractor is not overfit to the primary fixture's paths/verbs/param name.
@Controller('notifications')
export class NotificationController {
    @Get()
    list(): string {
        return 'all';
    }

    @Get(':key')
    findOne(@Param('key') key: string): string {
        return key;
    }

    @Post()
    create(@Body() body: unknown): string {
        return 'created';
    }

    @Patch(':key/read')
    markRead(@Param('key') key: string): string {
        return 'read';
    }
}
