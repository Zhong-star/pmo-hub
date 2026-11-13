import { ApiSchema } from '@nestjs/swagger';
import { LessonDraftFieldsRequest } from './lesson-fields-request.dto';

@ApiSchema({ name: 'CreateLessonRequest' })
export class CreateLessonRequest extends LessonDraftFieldsRequest {}
