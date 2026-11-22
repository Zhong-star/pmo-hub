import { Column, Entity, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'resource_initiatives' })
export class ResourceInitiative {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  code!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'code_used', type: 'boolean', default: false, select: false })
  codeUsed!: boolean;

  @VersionColumn({ default: 1 })
  version!: number;
}
