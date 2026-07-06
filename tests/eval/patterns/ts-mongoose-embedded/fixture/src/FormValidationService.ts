import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ValidationErrorLogEntity } from './ValidationErrorLog.entity';

@Injectable()
export class FormValidationService {
    constructor(
        @InjectModel(ValidationErrorLogEntity.name)
        private readonly errorLogModel: Model<ValidationErrorLogEntity>,
    ) {}

    async logValidationError(
        errors: any[],
        payload: any,
        operation: 'close' | 'update',
        quoteId?: { id: number; type: string },
    ): Promise<void> {
        await this.errorLogModel.create({
            errors,
            payload,
            operation,
            quoteId,
        });
    }

    async findRecentErrors(limit = 100): Promise<ValidationErrorLogEntity[]> {
        return this.errorLogModel
            .find()
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean()
            .exec();
    }
}
