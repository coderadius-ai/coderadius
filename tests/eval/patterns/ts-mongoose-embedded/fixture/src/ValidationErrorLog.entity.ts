import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as SchemaM } from 'mongoose';

// ── Embedded subdocument (NOT a standalone collection) ───────────────
@Schema({ _id: false })
class QuoteIdSubEntity {
    @Prop({ required: true })
    id!: number;

    @Prop({ required: true, type: SchemaM.Types.String })
    type!: string;
}

const QuoteIdSubSchema = SchemaFactory.createForClass(QuoteIdSubEntity);

// ── Standalone collection ────────────────────────────────────────────
@Schema({
    collection: 'validation_error_log',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
})
export class ValidationErrorLogEntity {
    id!: string;

    @Prop({ required: true, type: SchemaM.Types.Mixed })
    errors!: any[];

    @Prop({ required: true, type: SchemaM.Types.Mixed })
    payload!: any;

    @Prop({ required: true, type: SchemaM.Types.String })
    operation!: 'close' | 'update';

    @Prop({ type: QuoteIdSubSchema })
    quoteId?: any;
}

export const ValidationErrorLogSchema = SchemaFactory.createForClass(ValidationErrorLogEntity);

ValidationErrorLogSchema.index({ createdAt: 1 }, { expires: '90d' });
ValidationErrorLogSchema.virtual('id').get(function () {
    return this._id.toHexString();
});
