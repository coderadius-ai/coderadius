import { Inject, Injectable } from '@nestjs/common'
import { function as F, taskEither as TE } from 'fp-ts'

// Mocks
export interface AppError { name: string; message: string; }
export interface ILogger { error(m: string, meta?: any): void; }
export interface MessageEmitterService {
    emitEvent(p: any): TE.TaskEither<any, void>;
    decorateMessage(d: any, id: string, urn: string, ev: string, v: string): any;
}

@Injectable()
export class SystemEventService {
    private static readonly EVENT_NAME = 'system.event.created'

    constructor(
        private readonly logger: ILogger,
        private readonly messageEmitterService: MessageEmitterService
    ) { }

    emit(entityId: any, type: any, metadata: any): TE.TaskEither<AppError, void> {
        const eventId = "some-id";
        const eventData = { entityId, type, metadata };

        return F.pipe(
            this.messageEmitterService.emitEvent({
                eventName: SystemEventService.EVENT_NAME,
                message: JSON.stringify(
                    this.messageEmitterService.decorateMessage(
                        eventData,
                        eventId,
                        'urn::acme::core::event::created',
                        SystemEventService.EVENT_NAME,
                        '1.0.0'
                    )
                )
            })
        )
    }
}
