// Each method of this class returns a new model instance, which can be
// used to manipulate the database.
//
// These instances should be used within the current function, then
// **discarded**. The caller in particular should not keep a copy of the
// model and re-use it across multiple calls as doing so might cause issues
// with the way transactions are managed, especially when concurrency is
// involved.
//
// If a copy of the model is kept, the following could happen:
//
// - Async function1 calls some model function that initiates a transaction
// - Async function2, in parallel, calls a function that also initiates a
//   transaction.
//
// Because of this, the transaction stack in BaseModel will be out of
// order, and function2 might pop the transaction of function1 or
// vice-versa. Possibly also commit or rollback the transaction of the
// other function.
//
// For that reason, models should be used in a linear way, with each
// function call being awaited before starting the next one.
//
// If multiple parallel calls are needed, multiple models should be
// created, one for each "thread".
//
// Creating a model is cheap, or should be, so it is not an issue to create
// and destroy them frequently.
//
// Perhaps all this could be enforced in code, but not clear how.

// So this is GOOD:

//    class FileController {
//        public async deleteFile(id:string) {
//            const fileModel = this.models.file();
//            await fileModel.delete(id);
//        }
//    }

// This is BAD:

//    class FileController {
//
//        private fileModel;
//
//        public constructor() {
//            // BAD - Don't keep and re-use a copy of it!
//            this.fileModel = this.models.file();
//        }
//
//        public async deleteFile(id:string) {
//            await this.fileModel.delete(id);
//        }
//    }

import { DbConnection } from '../db';
import ApiClientModel from './ApiClientModel';
import { ModelOptions } from './BaseModel';
import FileModel from './FileModel';
import UserModel from './UserModel';
import PermissionModel from './PermissionModel';
import SessionModel from './SessionModel';
import ChangeModel from './ChangeModel';
import NotificationModel from './NotificationModel';

export class Models {

	private db_: DbConnection;
	private baseUrl_: string;

	public constructor(db: DbConnection, baseUrl: string) {
		this.db_ = db;
		this.baseUrl_ = baseUrl;
	}

	public file(options: ModelOptions = null) {
		return new FileModel(this.db_, newModelFactory, this.baseUrl_, options);
	}

	public user(options: ModelOptions = null) {
		return new UserModel(this.db_, newModelFactory, this.baseUrl_, options);
	}

	public apiClient(options: ModelOptions = null) {
		return new ApiClientModel(this.db_, newModelFactory, this.baseUrl_, options);
	}

	public permission(options: ModelOptions = null) {
		return new PermissionModel(this.db_, newModelFactory, this.baseUrl_, options);
	}

	public session(options: ModelOptions = null) {
		return new SessionModel(this.db_, newModelFactory, this.baseUrl_, options);
	}

	public change(options: ModelOptions = null) {
		return new ChangeModel(this.db_, newModelFactory, this.baseUrl_, options);
	}

	public notification(options: ModelOptions = null) {
		return new NotificationModel(this.db_, newModelFactory, this.baseUrl_, options);
	}

}

export default function newModelFactory(db: DbConnection, baseUrl: string): Models {
	return new Models(db, baseUrl);
}
